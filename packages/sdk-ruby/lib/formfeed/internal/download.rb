# frozen_string_literal: true

module Formfeed
  module Internal
    # A signed link of the CDN, fetched without the API key, which the link does not need. Not
    # retried, as no SDK retries a download; redirects are followed, as the other SDKs' HTTP clients
    # follow them.
    class Download
      REDIRECTS = [301, 302, 303, 307, 308].freeze
      MAX_REDIRECTS = 5

      # A failure to write, kept apart from the network errors while the body streams.
      class WriteFailed < StandardError; end
      private_constant :WriteFailed

      def initialize(connection, user_agent)
        @connection = connection
        @headers = { "Accept" => "*/*", "User-Agent" => user_agent }.freeze
      end

      # The bytes, or with +target+ (a path or an IO) the number of bytes written there.
      def call(url, target = nil)
        uri = URI.parse(url)
        (MAX_REDIRECTS + 1).times do
          outcome = fetch(uri, target)
          return outcome unless outcome.is_a?(URI::Generic)

          uri = outcome
        end
        raise Error.new("download_failed", "download answered more than #{MAX_REDIRECTS} redirects")
      end

      private

      # One step: the result, or the URI a redirect points at.
      def fetch(uri, target)
        outcome = nil
        @connection.perform("GET", uri, @headers, nil) { |response| outcome = receive(uri, response, target) }
        outcome
      rescue WriteFailed => e
        raise e.cause
      rescue *Connection::NETWORK_ERRORS => e
        raise Error.new("network_error", e.message)
      end

      def receive(uri, response, target)
        status = response.code.to_i
        location = response["Location"]
        return uri + location if REDIRECTS.include?(status) && location && !location.empty?
        raise Error.new("download_failed", "download answered HTTP #{status}", status: status) if status >= 400

        target.nil? ? response.read_body.to_s.b : write(response, target)
      end

      # Into an IO as it is, or into a file a path names, which a broken download does not leave
      # behind.
      def write(response, target)
        return stream(response, target) if target.respond_to?(:write)

        file = begin
          File.open(target, "wb")
        rescue SystemCallError, IOError
          raise WriteFailed
        end
        begin
          stream(response, file)
        rescue StandardError
          file.close
          remove(target)
          raise
        ensure
          file.close unless file.closed?
        end
      end

      def stream(response, io)
        written = 0
        response.read_body do |chunk|
          begin
            io.write(chunk)
          rescue SystemCallError, IOError
            raise WriteFailed
          end
          written += chunk.bytesize
        end
        written
      end

      def remove(path)
        File.delete(path)
      rescue SystemCallError
        # already gone, or never there
      end
    end
  end
end
