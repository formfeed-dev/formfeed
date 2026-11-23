# frozen_string_literal: true

module Formfeed
  module Internal
    # Auth, retries and problems, the rules every Formfeed SDK keeps (plan 34, decision 3): up to
    # +max_retries+ retries on 429, 503 and network errors, waiting a positive numeric +Retry-After+
    # in seconds, else 0.5 s doubling, plus up to 0.25 s of jitter, at most 30 s; a problem becomes
    # one Formfeed::Error with the code, the detail (else the title), the status and +X-Request-Id+.
    # +packages/api-types/fixtures/sdk+ holds the cases, which every SDK's tests play.
    class Transport
      USER_AGENT = "formfeed-sdk-ruby/0.3"
      MAX_JITTER = 0.25
      NUMBER = /\A[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\z/

      def initialize(api_key:, base_url:, max_retries:, timeout:, headers:, sleep:, jitter:)
        @api_key = api_key
        @base_url = base_url
        @max_retries = max_retries
        @connection = Connection.new(timeout)
        @headers = headers.to_h { |name, value| [name.to_s, value.to_s] }
        @sleep = sleep || ->(seconds) { Kernel.sleep(seconds) }
        @jitter = jitter || -> { Random.rand(0..250_000) / 1_000_000.0 }
      end

      # The key stays out of logs and consoles.
      def inspect
        "#<#{self.class.name} #{@base_url}>"
      end

      # The decoded JSON answer, nil for one without a body (204).
      def json(method, path, body = nil, idempotency_key = nil)
        response = send_request(method, path, body, idempotency_key)
        status = response.code.to_i
        text = response.body.to_s
        return nil if status == 204 || text.empty?

        begin
          JSON.parse(text)
        rescue JSON::ParserError, EncodingError
          raise Error.new("invalid_response", "the API answered HTTP #{status} with a body that is not JSON",
                          status: status)
        end
      end

      # An answer that is a JSON object.
      def object(method, path, body = nil, idempotency_key = nil)
        value = json(method, path, body, idempotency_key)
        return value if value.is_a?(Hash)

        raise Error.new("invalid_response", "the API answered #{method} #{path} without a JSON object")
      end

      # Waits, the way the client was told to (seconds).
      def wait(seconds)
        @sleep.call(seconds)
      end

      # The seconds to wait before retry number +attempt+ (from 1), with the server's Retry-After.
      def backoff(attempt, retry_after)
        base = 0.5 * (2**(attempt - 1))
        header = retry_after.to_s.strip
        value = NUMBER.match?(header) ? Float(header, exception: false) : nil
        base = value if value&.positive? && value.finite?
        [30.0, base + @jitter.call.to_f.clamp(0.0, MAX_JITTER)].min
      end

      # A signed link of the CDN: the bytes, or with +target+ (a path or an IO) the number of bytes
      # written there.
      def download(url, target = nil)
        Download.new(@connection, USER_AGENT).call(url, target)
      end

      private

      def send_request(method, path, body, idempotency_key)
        uri = URI.parse("#{@base_url}#{path}")
        headers = request_headers(body, idempotency_key)
        payload = payload_of(body)
        attempt = 0
        loop do
          begin
            response = @connection.perform(method, uri, headers, payload)
          rescue *Connection::NETWORK_ERRORS => e
            raise Error.new("network_error", e.message) if attempt >= @max_retries

            attempt += 1
            wait(backoff(attempt, nil))
            next
          end

          status = response.code.to_i
          if [429, 503].include?(status) && attempt < @max_retries
            attempt += 1
            wait(backoff(attempt, response["Retry-After"]))
            next
          end
          raise problem(response) if status >= 400

          return response
        end
      end

      def request_headers(body, idempotency_key)
        headers = {
          "Authorization" => "Bearer #{@api_key}",
          "Accept" => "application/json",
          "User-Agent" => USER_AGENT
        }.merge(@headers)
        headers["Idempotency-Key"] = idempotency_key unless idempotency_key.nil?
        if body.is_a?(Multipart)
          headers["Content-Type"] = body.content_type
        elsif !body.nil?
          headers["Content-Type"] = "application/json"
        end
        headers
      end

      # The bytes of the body, made once, so every attempt sends the same ones.
      def payload_of(body)
        case body
        when nil then nil
        when Multipart then body.body
        else JSON.generate(body)
        end
      end

      def problem(response)
        status = response.code.to_i
        fields = problem_fields(response.body.to_s)
        Error.new(
          present(Fields.string_or_nil(fields, "code")) || "http_#{status}",
          present(Fields.string_or_nil(fields, "detail")) || present(Fields.string_or_nil(fields, "title")) ||
            "HTTP #{status}",
          status: status,
          problem: fields.empty? ? nil : Problem.from_hash(fields),
          request_id: present(response["X-Request-Id"])
        )
      end

      def problem_fields(text)
        return {} if text.empty?

        decoded = JSON.parse(text)
        decoded.is_a?(Hash) ? decoded : {}
      rescue JSON::ParserError, EncodingError
        # a body that is not JSON, such as a proxy's page: the status speaks for it
        {}
      end

      def present(text)
        text.nil? || text.empty? ? nil : text
      end
    end
  end
end
