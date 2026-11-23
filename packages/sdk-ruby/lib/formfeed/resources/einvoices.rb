# frozen_string_literal: true

module Formfeed
  module Resources
    # E-invoices: which rules one passed.
    class Einvoices
      def initialize(transport)
        @transport = transport
      end

      # Which rules an e-invoice passed. A render of this workspace's own e-invoice (a Render or its
      # id) is answered from the report it keeps, free; an XML Formfeed did not make (an Upload, up
      # to 4 MB, from the Starter plan) takes one of the organisation's validations of the day. Needs
      # +einvoice:validate+. +rules:+ is +auto+, +factur-x+, +xrechnung+ or +en16931+, the render's
      # own when nil. Answers the report as a Hash: +result+, the +checks+ with their findings,
      # +validator+, +rules+ and +versions+.
      def validate(source, rules: nil, idempotency_key: nil)
        body =
          if source.is_a?(Upload)
            Internal::Multipart.new({ "rules" => rules }, source)
          else
            { "render_id" => Internal::Ids.of(source) }.merge(rules.nil? ? {} : { "rules" => rules })
          end
        @transport.object("POST", "/einvoices/validate", body, idempotency_key || Internal::Ids.key)
      end
    end
  end
end
