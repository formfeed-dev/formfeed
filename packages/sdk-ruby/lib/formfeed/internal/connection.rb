# frozen_string_literal: true

module Formfeed
  module Internal
    # One request with Net::HTTP on a connection of its own, within the client's time limits:
    # connecting takes at most 10 seconds, sending and each read at most +timeout+. Net::HTTP's own
    # retry is off, as the transport retries; network failures are raised as they are.
    class Connection
      # What Net::HTTP raises when a connection fails, times out or breaks off.
      NETWORK_ERRORS = [
        IOError, SocketError, SystemCallError, Timeout::Error, OpenSSL::SSL::SSLError,
        Net::HTTPBadResponse, Net::HTTPHeaderSyntaxError, Net::ProtocolError, Zlib::Error
      ].freeze

      def initialize(timeout)
        @timeout = timeout
      end

      # The response; with a block, the response is handed to it before its body is read.
      def perform(method, uri, headers, payload, &)
        http = Net::HTTP.new(uri.hostname, uri.port)
        http.use_ssl = uri.scheme == "https"
        http.open_timeout = [@timeout, 10].min
        http.read_timeout = @timeout
        http.write_timeout = @timeout
        http.max_retries = 0
        # a body-less POST says so, without the form type Net::HTTP would give an empty body
        headers = headers.merge("Content-Length" => "0") if payload.nil? && %w[POST PUT PATCH].include?(method)
        request = Net::HTTPGenericRequest.new(method, !payload.nil?, method != "HEAD", uri.request_uri, headers)
        request.body = payload unless payload.nil?
        http.start { |connection| connection.request(request, &) }
      end
    end
  end
end
