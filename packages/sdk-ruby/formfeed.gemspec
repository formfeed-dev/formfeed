# frozen_string_literal: true

require_relative "lib/formfeed/version"

Gem::Specification.new do |spec|
  spec.name = "formfeed"
  spec.version = Formfeed::VERSION
  spec.authors = ["Formfeed"]
  spec.email = ["support@formfeed.dev"]

  spec.summary = "Ruby client for the Formfeed API: PDFs and images from templates, HTML or URLs."
  spec.description = "Renders PDFs and images from templates, HTML, URLs or Markdown through the Formfeed API, " \
                     "and runs its tools on existing PDFs (merge, protect, watermark, split, compress, redact, " \
                     "fill, convert), with retries, idempotency keys and webhook verification. Ruby's standard " \
                     "library only."
  spec.homepage = "https://formfeed.dev"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.3"

  spec.metadata = {
    "source_code_uri" => "https://github.com/formfeed-dev/formfeed",
    "documentation_uri" => "https://docs.formfeed.dev",
    "rubygems_mfa_required" => "true"
  }

  # listed from the folder, not from git, so the gem builds from a copy of this folder alone
  spec.files = Dir.glob("lib/**/*.rb", base: __dir__).sort + %w[LICENSE README.md]
  spec.require_paths = ["lib"]
end
