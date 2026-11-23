# frozen_string_literal: true

module Formfeed
  # The Formfeed API.
  #
  #   formfeed = Formfeed::Client.new(api_key: ENV.fetch("FORMFEED_API_KEY"))
  #   render = formfeed.renders.create(template: "invoice", data: data)
  #   formfeed.renders.download_to(render, "invoice.pdf")
  #
  # It sends with Net::HTTP of Ruby's standard library, a connection per request, so one client can
  # be shared by threads.
  class Client
    HOSTS = {
      "eu" => "https://api-eu.formfeed.dev/v1",
      "us" => "https://api-us.formfeed.dev/v1"
    }.freeze

    attr_reader :renders, :jobs, :pdf, :einvoices, :files, :templates, :webhooks, :account

    # +region+ is +eu+ or +us+, ignored when +base_url+ (the full base URL with +/v1+, for a local
    # or another gateway) is given. +max_retries+ counts the retries on 429, 503 and network errors,
    # 0 turns them off; +timeout+ is in seconds, for connecting (at most 10), sending and each read;
    # +headers+ are sent with every request, after the SDK's own. +sleep+ is how to wait between
    # retries and polls (a callable taking seconds), +jitter+ what to add to a retry's wait (a
    # callable answering 0 to 0.25 seconds); tests pass both.
    def initialize(api_key:, region: "eu", base_url: nil, max_retries: 3, timeout: 120, headers: {},
                   sleep: nil, jitter: nil)
      raise Error.new("invalid_request", "api_key is required") if api_key.nil? || api_key.to_s.empty?

      host = base_url || HOSTS[region.to_s]
      raise Error.new("invalid_request", "unknown region #{region}: eu or us, or a base_url") if host.nil?

      @transport = Internal::Transport.new(
        api_key: api_key.to_s, base_url: host.to_s.chomp("/"), max_retries: [0, max_retries.to_i].max,
        timeout: timeout, headers: headers, sleep: sleep, jitter: jitter
      )
      build_resources
    end

    # Any call of the API with the client's key, retries and problems, for one without a method here
    # (template authoring, channels, shared partials): the decoded JSON answer, nil for none.
    #
    #   formfeed.request(:get, "/brand")
    def request(method, path, body = nil, idempotency_key: nil)
      @transport.json(method.to_s.upcase, path, body, idempotency_key)
    end

    # The key stays out of logs and consoles.
    def inspect
      "#<#{self.class.name} #{@transport.inspect}>"
    end

    private

    def build_resources
      @renders = Resources::Renders.new(@transport)
      @jobs = Resources::Jobs.new(@transport)
      @pdf = Resources::Pdf.new(@transport)
      @einvoices = Resources::Einvoices.new(@transport)
      @files = Resources::Files.new(@transport)
      @templates = Resources::Templates.new(@transport)
      @webhooks = Resources::Webhooks.new(@transport)
      @account = Resources::Account.new(@transport)
    end
  end
end
