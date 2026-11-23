# frozen_string_literal: true

require "stringio"
require "tmpdir"
require "test_helper"

class ClientTest < FormfeedTest::TestCase
  RENDER = FormfeedTest::RENDER
  UUID = FormfeedTest::UUID

  def test_a_render_sends_the_key_an_idempotency_key_and_json
    answer { json(RENDER, status: 201) }

    render = client.renders.create(template: "invoice", data: { a: 1 }, output: "pdf")

    assert_equal "rnd_1", render.id
    assert_predicate render, :finished?
    assert_equal 1, render.page_count
    assert_equal "invoice", render.template["slug"]
    sent = request(0)

    assert_equal :post, sent.method
    assert_equal "https://api-eu.formfeed.dev/v1/renders", url(sent)
    assert_equal "Bearer ff_test_k", header(sent, "Authorization")
    assert_equal "formfeed-sdk-ruby/0.3", header(sent, "User-Agent")
    assert_equal "application/json", header(sent, "Accept")
    assert_equal "application/json", header(sent, "Content-Type")
    assert_match UUID, header(sent, "Idempotency-Key")
    assert_equal({ "template" => "invoice", "data" => { "a" => 1 }, "output" => "pdf" }, body(sent))
  end

  def test_a_request_as_a_hash_and_as_keywords_is_one_request
    answer { json(RENDER, status: 201) }

    client.renders.create({ "template" => "invoice", "data" => {} }, output: "png")

    assert_equal '{"template":"invoice","data":{},"output":"png"}', request(0).body
  end

  def test_empty_data_is_sent_as_an_object
    answer { json(RENDER, status: 201) }

    client.renders.create(template: "invoice", data: {})

    assert_equal '{"template":"invoice","data":{}}', request(0).body
  end

  def test_a_given_idempotency_key_is_sent_as_it_is
    answer { json(RENDER, status: 201) }

    client.renders.create(html: "<p>x</p>", idempotency_key: "order-1234")

    assert_equal "order-1234", header(request(0), "Idempotency-Key")
    assert_equal({ "html" => "<p>x</p>" }, body(request(0)))
  end

  def test_the_region_or_a_base_url_names_the_host
    answer { json(RENDER) }

    client(region: "us").renders.get("rnd_1")
    client(region: :us).renders.get("rnd_1")
    client(base_url: "http://localhost:8787/v1/").renders.get("rnd_1")

    assert_equal "https://api-us.formfeed.dev/v1/renders/rnd_1", url(request(0))
    assert_equal "https://api-us.formfeed.dev/v1/renders/rnd_1", url(request(1))
    assert_equal "http://localhost:8787/v1/renders/rnd_1", url(request(2))
  end

  def test_an_unknown_region_is_refused
    error = assert_raises(Formfeed::Error) { client(region: "ap") }

    assert_equal "invalid_request", error.code
    assert_match(/unknown region/, error.message)
  end

  def test_a_key_is_required_and_stays_out_of_inspect
    assert_raises(Formfeed::Error) { Formfeed::Client.new(api_key: "") }
    refute_includes client.inspect, "ff_test_k"
  end

  def test_a_problem_becomes_one_error
    answer do
      json({ "type" => "https://docs.formfeed.dev/errors/quota-exceeded", "title" => "Quota exceeded", "status" => 402,
             "detail" => "The period has no units left.", "code" => "quota_exceeded",
             "period_end" => "2026-12-01" }, status: 402, headers: { "X-Request-Id" => "req_9" })
    end

    error = assert_raises(Formfeed::Error) { client.renders.create(template: "invoice") }

    assert_equal "quota_exceeded", error.code
    assert_equal "The period has no units left.", error.message
    assert_equal 402, error.status
    assert_equal "req_9", error.request_id
    assert_equal "Quota exceeded", error.problem.title
    assert_equal "https://docs.formfeed.dev/errors/quota-exceeded", error.problem.type
    assert_equal "2026-12-01", error.problem["period_end"]
  end

  def test_a_validation_problem_names_its_places
    answer do
      json({ "type" => "https://docs.formfeed.dev/errors/data-validation", "title" => "Data validation failed",
             "status" => 422, "detail" => "data.total must be a number", "code" => "data_validation_error",
             "request_id" => "req_1", "errors" => [{ "path" => "data.total", "message" => "must be number" }] },
           status: 422)
    end

    error = assert_raises(Formfeed::Error) { client.renders.create(template: "invoice", data: { total: "x" }) }

    assert_equal [{ "path" => "data.total", "message" => "must be number" }], error.problem.errors
    assert_equal "req_1", error.problem.request_id
  end

  def test_a_retry_sends_the_same_idempotency_key
    rate_limited = json({ "code" => "rate_limited" }, status: 429, headers: { "Retry-After" => "1" })
    answer { |_, n| n == 1 ? rate_limited : json(RENDER, status: 201) }

    client.renders.create(template: "invoice")

    assert_equal 2, requests.size
    assert_equal header(request(0), "Idempotency-Key"), header(request(1), "Idempotency-Key")
    assert_equal 1, waits.size
    assert_operator waits[0], :>=, 1.0
    assert_operator waits[0], :<=, 1.25
  end

  def test_a_body_that_is_not_json_is_an_invalid_response
    answer { { status: 200, headers: { "Content-Type" => "text/html" }, body: "<html>" } }

    error = assert_raises(Formfeed::Error) { client.account.get }

    assert_equal "invalid_response", error.code
    assert_equal 200, error.status
  end

  def test_a_network_error_names_itself_after_the_retries
    stub_request(:get, "https://api-eu.formfeed.dev/v1/account").to_timeout

    error = assert_raises(Formfeed::Error) { client(max_retries: 1).account.get }

    assert_equal "network_error", error.code
    assert_equal 0, error.status
    assert_equal 1, waits.size
  end

  def test_wait_for_polls_until_the_render_is_finished
    answer { |_, n| json(n < 3 ? { "id" => "rnd_1", "status" => "processing" } : RENDER) }

    render = client.renders.wait_for("rnd_1")

    assert_equal "succeeded", render.status
    assert_equal 3, requests.size
    assert_equal [1, 1], waits
  end

  def test_wait_for_ends_at_its_timeout
    answer { json({ "id" => "rnd_1", "status" => "queued" }) }

    error = assert_raises(Formfeed::Error) { client.renders.wait_for("rnd_1", timeout: 3, interval: 1) }

    assert_equal "timeout", error.code
    assert_equal [1, 1, 1], waits
    assert_equal 4, requests.size
  end

  def test_a_job_is_followed_until_no_render_of_it_runs
    job = { "id" => "job_1", "type" => "batch", "total" => 1, "items" => [RENDER] }
    answer { |_, n| json(job.merge("status" => n == 1 ? "processing" : "completed")) }

    finished = client.jobs.wait_for("job_1")

    assert_predicate finished, :finished?
    assert_equal ["rnd_1"], finished.items.map(&:id)
    assert_equal [2], waits
  end

  def test_a_batch_carries_an_idempotency_key
    answer { json({ "id" => "job_1", "status" => "queued", "total" => 2, "items" => [] }, status: 202) }

    job = client.renders.batch(template: "invoice", items: [{ data: { n: 1 } }, { data: { n: 2 } }], zip: true)

    assert_equal "job_1", job.id
    assert_equal "https://api-eu.formfeed.dev/v1/renders/batch", url(request(0))
    assert_match UUID, header(request(0), "Idempotency-Key")
    assert_equal [{ "data" => { "n" => 1 } }, { "data" => { "n" => 2 } }], body(request(0))["items"]
  end

  def test_a_download_follows_the_signed_link_without_the_key
    answer { { status: 200, headers: { "Content-Type" => "application/pdf" }, body: "%PDF-1.7 \xE2\x9C\x93".b } }

    bytes = client.renders.download(Formfeed::Render.from_hash(RENDER))

    assert_equal "%PDF-1.7 \xE2\x9C\x93".b, bytes
    assert_equal Encoding::BINARY, bytes.encoding
    assert_equal "https://cdn.formfeed.test/o/x.pdf?exp=1&sig=2", url(request(0))
    assert_nil header(request(0), "Authorization")
  end

  def test_a_download_by_id_asks_for_the_render_first
    answer { |_, n| n == 1 ? json(RENDER) : { status: 200, body: "%PDF" } }

    assert_equal "%PDF", client.renders.download("rnd_1")
    assert_equal "https://api-eu.formfeed.dev/v1/renders/rnd_1", url(request(0))
  end

  def test_a_download_follows_a_redirect
    stub_request(:get, "https://cdn.formfeed.test/o/x.pdf?exp=1&sig=2")
      .to_return(status: 302, headers: { "Location" => "/o/y.pdf" })
    stub_request(:get, "https://cdn.formfeed.test/o/y.pdf").to_return(status: 200, body: "%PDF")

    assert_equal "%PDF", client.renders.download(Formfeed::Render.from_hash(RENDER))
  end

  def test_a_download_streams_to_a_path_or_an_io
    answer { { status: 200, body: "%PDF-1.7" } }
    render = Formfeed::Render.from_hash(RENDER)
    io = StringIO.new(+"")

    Dir.mktmpdir do |dir|
      path = File.join(dir, "invoice.pdf")

      assert_equal 8, client.renders.download_to(render, path)
      assert_equal "%PDF-1.7", File.binread(path)
    end
    assert_equal 8, client.renders.download_to(render, io)
    assert_equal "%PDF-1.7", io.string
  end

  def test_a_failed_download_leaves_no_file
    answer { { status: 410, body: "gone" } }

    Dir.mktmpdir do |dir|
      path = File.join(dir, "invoice.pdf")
      error = assert_raises(Formfeed::Error) { client.renders.download_to(Formfeed::Render.from_hash(RENDER), path) }

      assert_equal "download_failed", error.code
      assert_equal 410, error.status
      refute_path_exists path
    end
  end

  def test_a_render_without_output_is_not_ready
    error = assert_raises(Formfeed::Error) do
      client.renders.download(Formfeed::Render.from_hash("id" => "rnd_2", "status" => "queued", "download_url" => nil))
    end

    assert_equal "not_ready", error.code
  end

  def test_all_follows_the_cursor_as_an_enumerator
    answer do |_, n|
      json(if n == 1
             { "data" => [RENDER, RENDER.merge("id" => "rnd_2")], "next_cursor" => "c2" }
           else
             { "data" => [RENDER.merge("id" => "rnd_3")], "next_cursor" => nil }
           end)
    end

    renders = client.renders.all(status: "failed")

    assert_kind_of Enumerator, renders
    assert_empty requests
    assert_equal %w[rnd_1 rnd_2 rnd_3], renders.map(&:id)
    assert_equal({ "status" => "failed" }, request(0).uri.query_values)
    assert_equal({ "status" => "failed", "cursor" => "c2" }, request(1).uri.query_values)
  end

  def test_all_asks_only_for_the_pages_it_needs
    answer { json({ "data" => [RENDER, RENDER.merge("id" => "rnd_2")], "next_cursor" => "c2" }) }

    assert_equal ["rnd_1"], client.files.all(prefix: "logos/").first(1).map(&:id)
    assert_equal 1, requests.size
    assert_equal({ "prefix" => "logos/" }, request(0).uri.query_values)
  end

  def test_a_page_enumerates_its_items
    answer { json({ "data" => [RENDER], "next_cursor" => nil }) }

    page = client.renders.list(template: "invoice", limit: 1)

    assert_equal ["rnd_1"], page.map(&:id)
    assert_predicate page, :last?
    assert_equal({ "template" => "invoice", "limit" => "1" }, request(0).uri.query_values)
  end

  def test_a_query_keeps_its_order_and_encodes_each_value
    query = Formfeed::Internal::Query.string(
      "status" => "failed", "since" => "2026-11-01T00:00:00+01:00", "q" => "Größe & mehr", "cursor" => nil,
      "tag" => "", "zip" => true, "limit" => 50, "skip" => { "a" => 1 }
    )

    assert_equal "?status=failed&since=2026-11-01T00%3A00%3A00%2B01%3A00&q=Gr%C3%B6%C3%9Fe%20%26%20mehr&zip=true" \
                 "&limit=50", query
  end

  def test_an_upload_goes_as_multipart_beside_the_options
    answer { json(RENDER) }

    client.pdf.redact(
      Formfeed::Upload.from_string("%PDF-1.7 bytes", "contract.pdf"),
      regions: [{ page: 1, x: 10, y: 20, width: 100, height: 12 }], fill: nil, flatten: true, expires_in: nil
    )

    sent = request(0)

    assert_equal "https://api-eu.formfeed.dev/v1/pdf/redact", url(sent)
    assert_match UUID, header(sent, "Idempotency-Key")
    assert_equal(
      {
        "file" => ["contract.pdf", "application/pdf", "%PDF-1.7 bytes"],
        "regions" => '[{"page":1,"x":10,"y":20,"width":100,"height":12}]',
        "fill" => "null",
        "flatten" => "true"
      },
      parts(sent)
    )
  end

  def test_an_upload_keeps_its_bytes_beside_text_that_is_not_ascii
    answer { json(RENDER) }
    bytes = "%PDF-1.7 \xFF\xFE\x00".b

    client.pdf.fill(Formfeed::Upload.from_string(bytes, "Vertrag ü.pdf"),
                    { "fields" => { "name" => "Erika Mustermann", "ort" => "Musterstraße 1" } })

    assert_equal(
      { "file" => ["Vertrag ü.pdf".b, "application/pdf", bytes],
        "fields" => '{"name":"Erika Mustermann","ort":"Musterstraße 1"}'.b },
      parts(request(0))
    )
  end

  def test_an_upload_reads_a_path_and_an_io
    Dir.mktmpdir do |dir|
      path = File.join(dir, "Report.DOCX")
      File.binwrite(path, "PK\x03\x04")
      upload = Formfeed::Upload.from_path(path)

      assert_equal "Report.DOCX", upload.name
      assert_equal "application/vnd.openxmlformats-officedocument.wordprocessingml.document", upload.content_type
      assert_equal "PK\x03\x04".b, upload.contents
      File.open(path, "rb") { |file| assert_equal "Report.DOCX", Formfeed::Upload.from_io(file).name }
    end
    assert_raises(ArgumentError) { Formfeed::Upload.from_path("/nowhere.pdf") }
    assert_raises(ArgumentError) { Formfeed::Upload.from_io(StringIO.new("x")) }
    assert_equal "application/octet-stream", Formfeed::Upload.from_io(StringIO.new("x"), name: "x").content_type
  end

  def test_a_stored_source_goes_as_json
    answer do |_, n|
      json(n == 1 ? { "source" => "rnd_9", "page_count" => 2, "pages" => [], "encrypted" => false,
                      "metadata" => {} } : RENDER)
    end

    info = client.pdf.info("rnd_9")
    client.pdf.compress(Formfeed::Render.from_hash(RENDER), filename: "small")

    assert_equal 2, info.page_count
    assert_equal({ "source" => "rnd_9" }, body(request(0)))
    assert_nil header(request(0), "Idempotency-Key")
    assert_equal '{"filename":"small","source":"rnd_1"}', request(1).body
    assert_match UUID, header(request(1), "Idempotency-Key")
  end

  def test_a_merge_takes_renders_and_library_files
    answer { json(RENDER) }

    client.pdf.merge([Formfeed::Render.from_hash(RENDER), "fil_2", "terms.pdf"], filename: "contract")

    assert_equal({ "filename" => "contract", "sources" => %w[rnd_1 fil_2 terms.pdf] }, body(request(0)))
  end

  def test_a_conversion_uploads_the_document
    answer { json(RENDER) }

    client.pdf.convert(Formfeed::Upload.from_string("PK", "offer.docx"), filename: "offer")

    assert_equal "https://api-eu.formfeed.dev/v1/pdf/convert", url(request(0))
    assert_equal(
      { "file" => ["offer.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "PK"],
        "filename" => "offer" },
      parts(request(0))
    )
  end

  def test_a_library_upload_names_the_file
    answer do
      json({ "id" => "fil_1", "name" => "logo.png", "content_type" => "image/png", "bytes" => 4, "sha256" => "ab",
             "url" => "https://cdn.formfeed.test/a/logo.png", "created_at" => "x", "updated_at" => "y" }, status: 201)
    end

    file = client.files.upload(Formfeed::Upload.from_string("\x89PNG", "logo.png"))

    assert_equal "fil_1", file.id
    assert_equal({ "file" => ["logo.png", "image/png", "\x89PNG".b], "name" => "logo.png" }, parts(request(0)))
    assert_nil header(request(0), "Idempotency-Key")
  end

  def test_an_einvoice_is_validated_by_its_render
    answer { json({ "valid" => true }) }

    report = client.einvoices.validate("rnd_1", rules: "xrechnung")

    assert report["valid"]
    assert_equal({ "render_id" => "rnd_1", "rules" => "xrechnung" }, body(request(0)))
    assert_match UUID, header(request(0), "Idempotency-Key")
  end

  def test_an_einvoice_upload_leaves_out_rules_it_does_not_name
    answer { json({ "valid" => true }) }

    client.einvoices.validate(Formfeed::Upload.from_string("<rsm:CrossIndustryInvoice/>", "invoice.xml"))

    assert_equal({ "file" => ["invoice.xml", "application/xml", "<rsm:CrossIndustryInvoice/>"] }, parts(request(0)))
  end

  def test_a_deletion_answers_nothing
    answer { { status: 204 } }

    assert_nil client.files.delete("fil_1")
    assert_equal :delete, request(0).method
    assert_equal "https://api-eu.formfeed.dev/v1/files/fil_1", url(request(0))
  end

  def test_webhook_endpoints_are_listed_and_managed
    endpoint = { "id" => "whk_1", "url" => "https://example.test/hook", "events" => ["render.completed"],
                 "enabled" => true }
    answer { |_, n| json(n == 1 ? { "data" => [endpoint] } : endpoint) }

    endpoints = client.webhooks.list
    client.webhooks.update(endpoints.first, enabled: false)

    assert_equal 1, endpoints.size
    assert_equal ["render.completed"], endpoints.first.events
    assert_equal :put, request(1).method
    assert_equal "https://api-eu.formfeed.dev/v1/webhooks/whk_1", url(request(1))
    assert_equal({ "enabled" => false }, body(request(1)))
  end

  def test_a_test_delivery_and_a_resend
    answer { json({ "queued" => true }) }

    client.webhooks.test("whk_1")
    client.webhooks.resend("evt_1", endpoint_id: "whk_1")

    assert_equal "https://api-eu.formfeed.dev/v1/webhooks/whk_1/test", url(request(0))
    assert_empty request(0).body.to_s
    assert_nil header(request(0), "Content-Type")
    assert_equal "https://api-eu.formfeed.dev/v1/webhooks/events/evt_1/resend", url(request(1))
    assert_equal({ "endpoint_id" => "whk_1" }, body(request(1)))
  end

  def test_a_template_schema_names_its_version
    answer { json({ "type" => "object" }) }

    client.templates.schema("invoice", version: "staging")

    assert_equal "https://api-eu.formfeed.dev/v1/templates/invoice/schema?version=staging", url(request(0))
  end

  def test_a_template_is_read_by_its_slug_and_checked_with_data
    answer do |_, n|
      json(n == 1 ? { "id" => "tpl_1", "slug" => "lieferschein/2026", "tags" => ["de", 1],
                      "kind" => "new-kind" } : { "valid" => true })
    end

    template = client.templates.get("lieferschein/2026")
    client.templates.validate("invoice", version: 3, data: {})

    assert_equal "https://api-eu.formfeed.dev/v1/templates/lieferschein%2F2026", url(request(0))
    assert_equal ["de"], template.tags
    assert_equal "new-kind", template.kind
    assert_equal '{"version":3,"data":{}}', request(1).body
  end

  def test_usage_names_its_period
    answer { json({ "period" => "2026-11", "included" => 1000, "used" => 12.5, "hard_cap_units" => nil }) }

    usage = client.account.usage("2026-11")

    assert_equal "https://api-eu.formfeed.dev/v1/usage?period=2026-11", url(request(0))
    assert_in_delta 1000.0, usage.included
    assert_in_delta 12.5, usage.used
    assert_nil usage.hard_cap_units
  end

  def test_models_read_fields_of_a_later_api_and_values_they_do_not_know
    render = Formfeed::Render.from_hash(RENDER.merge("status" => "archived", "output" => "avif",
                                                     "page_count" => "many", "new_field" => { "x" => 1 }))

    assert_equal "archived", render.status
    assert_equal "avif", render.output
    assert_nil render.page_count
    assert_equal({ "x" => 1 }, render.raw["new_field"])
    refute_predicate render, :finished?
  end

  def test_request_reaches_a_call_without_a_method
    answer { json({ "name" => "Fennlor Studio GmbH" }) }

    brand = client.request(:get, "/brand")

    assert_equal({ "name" => "Fennlor Studio GmbH" }, brand)
    assert_equal "https://api-eu.formfeed.dev/v1/brand", url(request(0))
    assert_nil header(request(0), "Idempotency-Key")
  end

  def test_request_sends_a_body_and_a_given_key
    answer { { status: 204 } }

    assert_nil client.request("put", "/partials/footer", { source: "<p>x</p>" }, idempotency_key: "k-1")
    assert_equal :put, request(0).method
    assert_equal '{"source":"<p>x</p>"}', request(0).body
    assert_equal "k-1", header(request(0), "Idempotency-Key")
  end

  def test_extra_headers_go_with_every_request
    answer { json({}) }

    Formfeed::Client.new(api_key: "ff_test_k", headers: { "X-Request-Id" => "req_mine" }).account.get

    assert_equal "req_mine", header(request(0), "X-Request-Id")
  end

  def test_a_webhook_is_parsed_once_its_signature_holds
    body = '{"id":"evt_1","type":"render.completed","data":{"id":"rnd_1"}}'
    now = 1_795_000_000
    signature = OpenSSL::HMAC.hexdigest("SHA256", "whsec_test", "#{now}.#{body}")

    event = Formfeed::Webhook.parse("whsec_test", "t=#{now},v1=#{signature}", body, now: now)

    assert_equal "render.completed", event["type"]
    assert_raises(Formfeed::Webhook::Error) do
      Formfeed::Webhook.parse("whsec_other", "t=#{now},v1=#{signature}", body, now: now)
    end
    # a signature that holds over a body that is no JSON object
    list = OpenSSL::HMAC.hexdigest("SHA256", "whsec_test", "#{now}.[1]")

    assert_raises(Formfeed::Webhook::Error) { Formfeed::Webhook.parse("whsec_test", "t=#{now},v1=#{list}", "[1]", now: now) }
  end

  def test_a_retry_after_is_read_as_seconds_and_capped
    transport = Formfeed::Internal::Transport.new(
      api_key: "k", base_url: "https://x.test", max_retries: 3, timeout: 1, headers: {}, sleep: nil, jitter: -> { 0 }
    )

    assert_in_delta 2.0, transport.backoff(1, "2")
    assert_in_delta 0.5, transport.backoff(1, "0x10")
    assert_in_delta 0.5, transport.backoff(1, "1_000")
    assert_in_delta 4.0, transport.backoff(4, "")
    assert_in_delta 30.0, transport.backoff(9, nil)
  end

  # One version for every package (plan 34, decision 6): the release bumps this one too.
  def test_the_version_is_the_releases_one
    skip "outside the Formfeed repository, which holds the release version" unless File.file?(FormfeedTest::PUBLISH)

    assert_includes File.read(FormfeedTest::PUBLISH), "export const VERSION = '#{Formfeed::VERSION}';"
  end
end
