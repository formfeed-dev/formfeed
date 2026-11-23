# frozen_string_literal: true

module Formfeed
  module Resources
    # The workspace's webhook endpoints. Needs +webhook:manage+. Verify a delivery with
    # Formfeed::Webhook.
    class Webhooks
      def initialize(transport)
        @transport = transport
      end

      # Every endpoint, as Formfeed::WebhookEndpoint.
      def list
        Internal::Fields.objects(@transport.object("GET", "/webhooks"), "data").map do |endpoint|
          WebhookEndpoint.from_hash(endpoint)
        end
      end

      # Registers an endpoint (+url:+, +events:+, +environments:+, +description:+); the answer
      # carries its +secret+, once.
      def create(input = {}, **fields)
        WebhookEndpoint.from_hash(@transport.object("POST", "/webhooks", Internal.params(input, fields)))
      end

      # Changes an endpoint: +url:+, +events:+, +environments:+, +description:+, +enabled:+.
      def update(endpoint, patch = {}, **fields)
        WebhookEndpoint.from_hash(
          @transport.object("PUT", "/webhooks/#{Internal::Ids.path(endpoint)}", Internal.params(patch, fields))
        )
      end

      def delete(endpoint)
        @transport.json("DELETE", "/webhooks/#{Internal::Ids.path(endpoint)}")
        nil
      end

      # Sends a test delivery to the endpoint; answers +queued+.
      def test(endpoint)
        @transport.object("POST", "/webhooks/#{Internal::Ids.path(endpoint)}/test")
      end

      # Sends a stored event (+evt_...+) again as a new delivery to an endpoint; answers the delivery.
      def resend(event_id, endpoint_id:)
        @transport.object(
          "POST", "/webhooks/events/#{Internal.escape(event_id)}/resend",
          { "endpoint_id" => Internal::Ids.of(endpoint_id) }
        )
      end
    end
  end
end
