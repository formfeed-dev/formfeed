# formfeed

The Ruby SDK for the [Formfeed](https://formfeed.dev/?utm_source=rubygems) API:
PDFs and images from templates, HTML, URLs or Markdown, and tools for existing PDFs. Ruby 3.3 or
newer, and nothing beyond Ruby's standard library.

```bash
bundle add formfeed
```

or `gem install formfeed`.

## Render a document

```ruby
require "formfeed"

formfeed = Formfeed::Client.new(api_key: ENV.fetch("FORMFEED_API_KEY"))

render = formfeed.renders.create(
  template: "invoice",
  data: { customer: { name: "Olvarest GmbH" }, total: 1428.00 }
)
formfeed.renders.download_to(render, "invoice.pdf")
```

A request takes keywords or one Hash, so `create("template" => "invoice", "data" => data)` sends the
same. Template data and settings are free hashes; answers are read into `Formfeed::Render`,
`Formfeed::Job` and the like, whose `raw` keeps the whole answer, fields of later API versions
included.

## Downloads

`download` answers the file as binary bytes, `download_to` streams it to a path or an IO and answers
the number of bytes written. Both take a render or its id; the signed link they follow needs no key.

```ruby
pdf = formfeed.renders.download(render)
send_data pdf, type: "application/pdf", filename: "invoice.pdf" # in a Rails controller

File.open("invoice.pdf", "wb") { |file| formfeed.renders.download_to(render, file) }
```

## Waiting for a render

A render is synchronous by default, so the answer is the finished render. With `mode: "async"` it
comes back queued, and `wait_for` asks until it is done:

```ruby
render = formfeed.renders.create(html: "<h1>Report</h1>", mode: "async")
render = formfeed.renders.wait_for(render, timeout: 120)
render.finished? # => true, succeeded or failed
```

Every call that creates a render sends an `Idempotency-Key`, so a retry cannot charge twice; pass
your own to tie it to your order:

```ruby
formfeed.renders.create(template: "invoice", data: data, idempotency_key: "order-1042")
```

Lists are pages (`list`) or Enumerators that follow the cursor as you go (`all`):

```ruby
formfeed.renders.all(status: "failed", since: "2026-11-01T00:00:00Z").each do |failed|
  puts "#{failed.id} #{failed.error&.fetch("code", nil)}"
end
```

## Batches

Up to 1,000 renders in one job, always asynchronous. Its renders keep the order of `items`:

```ruby
job = formfeed.renders.batch(
  template: "certificate",
  items: [
    { data: { name: "Max Mustermann" } },
    { data: { name: "Erika Mustermann" } }
  ],
  zip: true
)
job = formfeed.jobs.wait_for(job)
job.items.each_with_index do |item, index|
  formfeed.renders.download_to(item, "certificate-#{index + 1}.pdf") if item.status == "succeeded"
end
```

## PDF tools

On a render, a file of the library (its id or its name), or an upload, which is never stored:

```ruby
form = Formfeed::Upload.from_path("application.pdf")

info = formfeed.pdf.info(form)
info.form["fields"].map { |field| field["name"] } # the names fill takes

filled = formfeed.pdf.fill(form, fields: { "name" => "Max Mustermann", "accepted" => true }, flatten: true)
merged = formfeed.pdf.merge([filled, "terms.pdf"], filename: "application")
formfeed.renders.download_to(merged, "application.pdf")
```

`merge`, `protect`, `watermark`, `split`, `compress`, `to_image`, `redact`, `fill`, `convert` and
`info`, and `einvoices.validate` for an e-invoice's rules. `Upload.from_string(bytes, "a.pdf")` takes
bytes in memory, and `Upload.from_io` a File or an upload a Rails or Rack application received.

## Webhooks

`Formfeed::Webhook.parse` checks the `Webhook-Signature` header (HMAC-SHA256 of the raw body, at
most five minutes old, compared in constant time) and answers the event as a Hash; it raises
`Formfeed::Webhook::Error` when the signature does not match. `verify` answers true or false. Pass
the body exactly as it arrived.

In a Rails controller:

```ruby
class FormfeedWebhooksController < ActionController::API
  def create
    event = Formfeed::Webhook.parse(
      ENV.fetch("FORMFEED_WEBHOOK_SECRET"),
      request.headers["Webhook-Signature"],
      request.raw_post
    )
    case event["type"]
    when "render.completed" then InvoiceMailer.ready(event["data"]["id"]).deliver_later
    when "render.failed" then Rails.logger.warn("render #{event["data"]["id"]} failed")
    end
    head :no_content
  rescue Formfeed::Webhook::Error
    head :unauthorized
  end
end
```

As a Rack application:

```ruby
receiver = lambda do |env|
  request = Rack::Request.new(env)
  event = Formfeed::Webhook.parse(
    ENV.fetch("FORMFEED_WEBHOOK_SECRET"),
    request.get_header("HTTP_WEBHOOK_SIGNATURE"),
    request.body.read
  )
  puts "#{event["type"]} #{event["data"]["id"]}"
  [204, {}, []]
rescue Formfeed::Webhook::Error
  [401, {}, ["invalid signature"]]
end
```

## Errors and retries

Every problem the API answers is a `Formfeed::Error` with the problem's `code` (`quota_exceeded`,
`template_not_found`, …), the detail as its message, the HTTP `status`, the `request_id` support
asks for, and the whole `problem`. 429 and 503 answers and network errors are retried up to three
times, waiting what `Retry-After` says, else half a second doubling.

```ruby
begin
  formfeed.renders.create(template: "invoice", data: data)
rescue Formfeed::Error => e
  warn "#{e.code} (#{e.status}): #{e.message} [#{e.request_id}]"
  e.problem&.errors&.each { |error| warn "  #{error["path"]}: #{error["message"]}" }
end
```

## Options

```ruby
Formfeed::Client.new(
  api_key: ENV.fetch("FORMFEED_API_KEY"),
  region: "us",   # eu (the default) or us; or base_url: "http://localhost:8787/v1"
  max_retries: 5, # 0 turns retries off
  timeout: 60     # seconds; 120 by default
)
```

## Anything else

Template authoring, release channels and shared partials have no methods here yet;
`request` reaches any call of the API with the client's key, retries and errors, and answers the
decoded JSON:

```ruby
brand = formfeed.request(:get, "/brand")
```

The [documentation](https://docs.formfeed.dev) describes every call.

## License

MIT
