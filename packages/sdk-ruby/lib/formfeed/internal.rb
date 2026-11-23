# frozen_string_literal: true

module Formfeed
  # What the resources share; not part of the SDK's interface.
  module Internal
    module_function

    # One component of a path or query, percent-encoded as RFC 3986 asks (a space is %20).
    def escape(text)
      text.to_s.b.gsub(/[^A-Za-z0-9\-._~]/n) { |byte| format("%%%<byte>02X", byte: byte.ord) }
          .force_encoding(Encoding::US_ASCII)
    end

    # A request or query given as a Hash, as keywords or as both, with the top-level keys as
    # strings, so that +{ "template" => ... }+ and +template: ...+ name the same member.
    def params(given, fields)
      raise ArgumentError, "expected a Hash, got #{given.class}" unless given.is_a?(Hash)

      given.to_h { |key, value| [key.to_s, value] }.merge(fields.to_h { |key, value| [key.to_s, value] })
    end

    # Every item of a list, page by page as it is iterated: +fetch+ answers the page of a cursor.
    def pages(&fetch)
      Enumerator.new do |out|
        cursor = nil
        loop do
          page = fetch.call(cursor)
          page.data.each { |item| out << item }
          cursor = page.next_cursor
          break if cursor.nil?
        end
      end
    end

    # Asks for a render or job until it is finished, at most +timeout+ seconds, waiting +interval+
    # seconds between the questions; the time counts the waits, so an injected sleep counts too.
    def poll(transport, timeout, interval, what)
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      waited = 0.0
      loop do
        current = yield
        return current if current.finished?

        elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
        raise Error.new("timeout", "#{what} did not finish within the wait time") if
          [elapsed, waited].max + interval > timeout

        transport.wait(interval)
        waited += interval
      end
    end

    # The id of a render, job, library file or webhook endpoint, or the string given (an id or a
    # library file's name).
    module Ids
      module_function

      def of(item)
        return item if item.is_a?(String)
        return item.id if item.respond_to?(:id)

        raise ArgumentError, "expected an id or a Formfeed object with an id, got #{item.class}"
      end

      # A fresh Idempotency-Key: every call that creates a render sends one, so a retry cannot
      # charge twice.
      def key
        SecureRandom.uuid
      end

      # One path segment, encoded.
      def path(item)
        Internal.escape(of(item))
      end
    end

    # The query string of the values that are set.
    module Query
      module_function

      # +?a=1&b=2+ of the values that are set, or an empty string; booleans as +true+ and +false+,
      # anything that is not a string, symbol or number left out.
      def string(query)
        pairs = query.filter_map do |key, value|
          text = scalar(value)
          "#{Internal.escape(key)}=#{Internal.escape(text)}" unless text.nil? || text.empty?
        end
        pairs.empty? ? "" : "?#{pairs.join("&")}"
      end

      def scalar(value)
        case value
        when true then "true"
        when false then "false"
        when String, Symbol, Integer, Float then value.to_s
        end
      end
    end
  end
end
