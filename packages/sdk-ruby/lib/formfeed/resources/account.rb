# frozen_string_literal: true

module Formfeed
  module Resources
    # The key's account and the units it used.
    class Account
      def initialize(transport)
        @transport = transport
      end

      # The key's workspace and organisation, its environment, and the plan with the period's units
      # and limits, as a Hash.
      def get
        @transport.object("GET", "/account")
      end

      # Units of the current period, or of +YYYY-MM+, with a daily series and a breakdown per
      # template.
      def usage(period = "current")
        Usage.from_hash(@transport.object("GET", "/usage?period=#{Internal.escape(period)}"))
      end
    end
  end
end
