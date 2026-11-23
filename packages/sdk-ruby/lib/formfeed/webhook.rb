# frozen_string_literal: true

module Formfeed
  # Checks a webhook delivery: +Webhook-Signature: t=<unix>,v1=<hex>+, the HMAC-SHA256 of
  # +<t>.<raw body>+ with the endpoint's secret, at most 300 seconds either way, compared in constant
  # time. Pass the body exactly as it arrived: the signature covers the bytes on the wire.
  #
  #   event = Formfeed::Webhook.parse(secret, request.headers["Webhook-Signature"], request.raw_post)
  module Webhook
    # A delivery whose signature does not match, or whose body is not a JSON object.
    class Error < StandardError; end

    TOLERANCE = 300
    HEX = /\A[0-9a-f]{64}\z/
    DIGITS = /\A[0-9]+\z/

    module_function

    # True when the header signs this body with this secret, within +tolerance+ seconds of +now+.
    def verify(secret, signature_header, raw_body, tolerance: TOLERANCE, now: nil)
      return false if blank?(signature_header) || blank?(secret)

      parts = pairs(signature_header)
      t = parts.fetch("t", "")
      v1 = parts.fetch("v1", "").downcase
      return false unless DIGITS.match?(t) && HEX.match?(v1)

      time = t.to_i
      return false if ((now || Time.now.to_i) - time).abs > tolerance

      OpenSSL.fixed_length_secure_compare(OpenSSL::HMAC.hexdigest("SHA256", secret, "#{time}.#{raw_body}"), v1)
    end

    # The event of a verified delivery, with its +id+, +type+, +created_at+, +workspace_id+ and +data+;
    # raises Formfeed::Webhook::Error when the signature does not match.
    def parse(secret, signature_header, raw_body, tolerance: TOLERANCE, now: nil)
      raise Error, "invalid webhook signature" unless verify(secret, signature_header, raw_body,
                                                             tolerance: tolerance, now: now)

      event = begin
        JSON.parse(raw_body.to_s)
      rescue JSON::ParserError, EncodingError
        nil
      end
      raise Error, "the webhook body is not a JSON object" unless event.is_a?(Hash)

      event
    end

    def pairs(header)
      header.split(",").to_h do |pair|
        key, value = pair.strip.split("=", 2)
        [key.to_s.strip, value.to_s.strip]
      end
    end
    private_class_method :pairs

    def blank?(text)
      text.nil? || text.empty?
    end
    private_class_method :blank?
  end
end
