# frozen_string_literal: true

require "test_helper"

# The test vectors every Formfeed SDK reads (plan 34, decision 9), written by
# packages/api-types/src/lib/sdk-fixtures.spec.ts: webhook signatures, retries and problems, played
# through the client as a caller meets them. Every retry sequence runs at the lowest and at the
# highest jitter. The files travel with the SDK to the public repository, so a missing one fails.
class VectorsTest < FormfeedTest::TestCase
  ACCOUNT = "https://api-eu.formfeed.dev/v1/account"

  def self.cases(name)
    FormfeedTest.vectors(name).fetch("cases")
  rescue SystemCallError, JSON::ParserError => e
    define_method("test_#{name}_vectors_are_there") { flunk("#{name}.json cannot be read: #{e.message}") }
    []
  end

  cases("webhook-signatures").each do |example|
    define_method("test_webhook_signature: #{example.fetch("name")}") do
      vectors = FormfeedTest.vectors("webhook-signatures")
      valid = Formfeed::Webhook.verify(
        vectors.fetch("secret"), example.fetch("header"), example.fetch("body") || vectors.fetch("body"),
        tolerance: vectors.fetch("tolerance_seconds"), now: vectors.fetch("now")
      )

      assert_equal example.fetch("valid"), valid
    end
  end

  cases("retries").each do |example|
    { "lowest" => 0.0, "highest" => 0.25 }.each do |jitter, seconds|
      define_method("test_retries at the #{jitter} jitter: #{example.fetch("name")}") do
        play_retries(example, seconds)
      end
    end
  end

  cases("problems").each do |example|
    define_method("test_problem: #{example.fetch("name")}") do
      stub_request(:get, ACCOUNT).to_return(problem_answer(example))

      error = assert_raises(Formfeed::Error) { client(max_retries: 0).request(:get, "/account") }

      assert_equal(
        example.fetch("expect"),
        { "code" => error.code, "message" => error.message, "status" => error.status, "request_id" => error.request_id }
      )
    end
  end

  private

  def play_retries(example, jitter)
    answers = example.fetch("answers")
    stub = stub_request(:get, ACCOUNT)
    answers.each do |answer|
      next stub.to_raise(Errno::ECONNREFUSED) if answer["network_error"]

      headers = { "Content-Type" => "application/json" }
      headers["Retry-After"] = answer["retry_after"] if answer["retry_after"].is_a?(String)
      stub.to_return(status: answer.fetch("status", 200), headers: headers,
                     body: JSON.generate(answer.fetch("body", {})))
    end
    formfeed = client(max_retries: FormfeedTest.vectors("retries").fetch("max_retries"), jitter: -> { jitter })

    assert_equal(example.fetch("outcome"), outcome { formfeed.request(:get, "/account") })
    assert_requested(:get, ACCOUNT, times: answers.size)
    assert_waits(example.fetch("waits_ms"))
  end

  def outcome
    yield
    { "ok" => true }
  rescue Formfeed::Error => e
    { "error" => { "code" => e.code, "status" => e.status } }
  end

  def assert_waits(bounds)
    assert_equal bounds.size, waits.size, "the number of waits"
    waits.zip(bounds).each_with_index do |(seconds, (lowest, highest)), index|
      milliseconds = (seconds * 1000).round(6)

      assert_operator milliseconds, :>=, lowest, "wait #{index}"
      assert_operator milliseconds, :<=, highest, "wait #{index}"
    end
  end

  def problem_answer(example)
    headers = example.fetch("headers")
    case (body = example.fetch("body"))
    when nil then { status: example.fetch("status"), headers: headers }
    when String then { status: example.fetch("status"), headers: headers.merge("Content-Type" => "text/plain"),
                       body: body }
    else
      { status: example.fetch("status"), headers: headers.merge("Content-Type" => "application/json"),
        body: JSON.generate(body) }
    end
  end
end
