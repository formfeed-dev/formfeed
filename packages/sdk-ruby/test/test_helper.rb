# frozen_string_literal: true

require "json"
require "minitest/autorun"
require "webmock/minitest"
require "formfeed"

# What the tests share: where the repository's fixtures are, a client that records its waits
# instead of sleeping, and readers for what WebMock saw.
module FormfeedTest
  PACKAGE = File.expand_path("..", __dir__)
  # packages/api-types/fixtures in the Formfeed repository, and in the public repository the export
  SDK_FIXTURES = File.expand_path("../api-types/fixtures/sdk", PACKAGE)
  CONTRACT = File.expand_path("../api-types/fixtures/contract", PACKAGE)
  PUBLISH = File.expand_path("../../tools/publish/packages.mjs", PACKAGE)

  UUID = /\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/

  # A finished render as the API answers it.
  RENDER = {
    "id" => "rnd_1",
    "status" => "succeeded",
    "output" => "pdf",
    "download_url" => "https://cdn.formfeed.test/o/x.pdf?exp=1&sig=2",
    "expires_at" => "2026-12-18T10:00:00Z",
    "bytes" => 5681,
    "page_count" => 1,
    "units" => 1,
    "region" => "eu",
    "environment" => "test",
    "template" => { "id" => "tpl_1", "slug" => "invoice", "version" => 3 },
    "meta" => {},
    "created_at" => "2026-11-18T10:00:00Z",
    "completed_at" => "2026-11-18T10:00:01Z"
  }.freeze

  # The test vectors every Formfeed SDK reads; a missing file is an error, as it is in every SDK.
  def self.vectors(name)
    JSON.parse(File.read(File.join(SDK_FIXTURES, "#{name}.json")))
  end

  # A test case for the SDK's half of the shared fixtures.
  class TestCase < Minitest::Test
    attr_reader :waits, :requests

    def setup
      @waits = []
      @requests = []
    end

    # A client that records its waits instead of sleeping, with the jitter given.
    def client(max_retries: 3, region: "eu", base_url: nil, jitter: nil)
      Formfeed::Client.new(
        api_key: "ff_test_k", region: region, base_url: base_url, max_retries: max_retries,
        sleep: ->(seconds) { @waits << seconds }, jitter: jitter
      )
    end

    # Answers every request with what the block returns for it and its number (from 1), a Hash of
    # status, headers and body, and keeps the requests in order.
    def answer(&respond)
      stub_request(:any, /.*/).to_return do |request|
        @requests << request
        respond.call(request, @requests.size)
      end
    end

    def json(body, status: 200, headers: {})
      { status: status, headers: { "Content-Type" => "application/json" }.merge(headers), body: JSON.generate(body) }
    end

    def request(index)
      @requests.fetch(index)
    end

    # The URL as it was sent, without the default port WebMock writes into it.
    def url(request)
      WebMock::Util::URI.strip_default_port_from_uri_string(request.uri.to_s)
    end

    def body(request)
      JSON.parse(request.body)
    end

    def header(request, name)
      request.headers&.find { |key, _| key.casecmp?(name) }&.last
    end

    # The fields of a multipart request, the file under +file+ as [filename, content type, bytes].
    def parts(request)
      type = header(request, "Content-Type")
      assert_match(%r{\Amultipart/form-data; boundary=}, type)
      boundary = type.delete_prefix("multipart/form-data; boundary=")
      request.body.b.split("--#{boundary}").each_with_object({}) do |chunk, out|
        head, content = chunk.delete_prefix("\r\n").split("\r\n\r\n", 2)
        next if content.nil?

        name = head[/name="([^"]*)"/, 1]
        file = head[/filename="([^"]*)"/, 1]
        content = content.delete_suffix("\r\n")
        out[name] = file ? [file, head[/Content-Type: (.*)/, 1].strip, content] : content
      end
    end
  end
end
