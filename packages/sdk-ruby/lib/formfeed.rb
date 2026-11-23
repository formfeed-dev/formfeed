# frozen_string_literal: true

# Ruby's standard library only: these are default gems in every Ruby the SDK supports.
require "json"
require "net/http"
require "openssl"
require "securerandom"
require "uri"
require "zlib"

require_relative "formfeed/version"
require_relative "formfeed/error"
require_relative "formfeed/internal"
require_relative "formfeed/internal/fields"
require_relative "formfeed/internal/multipart"
require_relative "formfeed/internal/connection"
require_relative "formfeed/internal/download"
require_relative "formfeed/internal/transport"
require_relative "formfeed/upload"
require_relative "formfeed/webhook"
require_relative "formfeed/models/problem"
require_relative "formfeed/models/render"
require_relative "formfeed/models/job"
require_relative "formfeed/models/page"
require_relative "formfeed/models/render_input"
require_relative "formfeed/models/library_file"
require_relative "formfeed/models/template"
require_relative "formfeed/models/usage"
require_relative "formfeed/models/pdf_info"
require_relative "formfeed/models/webhook_endpoint"
require_relative "formfeed/resources/renders"
require_relative "formfeed/resources/jobs"
require_relative "formfeed/resources/pdf"
require_relative "formfeed/resources/einvoices"
require_relative "formfeed/resources/files"
require_relative "formfeed/resources/templates"
require_relative "formfeed/resources/webhooks"
require_relative "formfeed/resources/account"
require_relative "formfeed/client"

# The Formfeed API: PDFs and images from templates, HTML, URLs or Markdown, and tools for existing
# PDFs. Start with Formfeed::Client; check webhook deliveries with Formfeed::Webhook.
module Formfeed
end
