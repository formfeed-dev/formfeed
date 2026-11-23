# frozen_string_literal: true

module Formfeed
  module Internal
    # A multipart body the way the API reads it: the file as +file+, strings as they are, booleans
    # and numbers as text, arrays and hashes as JSON text. Nil fields are left out, as a form field
    # cannot say null, but for redact's +fill+, whose nil draws no box and goes as the JSON text
    # +null+.
    class Multipart
      # The fields as they are sent, for tests.
      attr_reader :fields

      def initialize(fields, file)
        @boundary = "formfeed-#{SecureRandom.hex(12)}"
        @file = file
        @fields = {}
        fields.each do |name, value|
          name = name.to_s
          next if value.nil? && name != "fill"

          @fields[name] = self.class.text(value)
        end
      end

      def self.text(value)
        case value
        when String then value
        when true then "true"
        when false then "false"
        when Integer, Float, Symbol then value.to_s
        else JSON.generate(value)
        end
      end

      def content_type
        "multipart/form-data; boundary=#{@boundary}"
      end

      # The bytes of the body, the same for every attempt.
      def body
        out = String.new(encoding: Encoding::BINARY)
        if @file
          out << "--#{@boundary}\r\n" \
                 "Content-Disposition: form-data; name=\"file\"; filename=\"#{quoted(@file.name)}\"\r\n" \
                 "Content-Type: #{@file.content_type}\r\n\r\n".b
          out << @file.contents.b << "\r\n"
        end
        @fields.each do |name, value|
          out << "--#{@boundary}\r\nContent-Disposition: form-data; name=\"#{quoted(name)}\"\r\n\r\n".b
          out << value.b << "\r\n"
        end
        out << "--#{@boundary}--\r\n"
      end

      private

      def quoted(value)
        value.gsub('"', "%22").delete("\r\n")
      end
    end
  end
end
