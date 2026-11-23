# frozen_string_literal: true

module Formfeed
  module Internal
    # Typed reads of a decoded answer. A field the API leaves out, or sends with a type this release
    # does not expect, reads as its default, so an SDK of today reads the answers of a later API (the
    # contract goldens hold that). Values the API may add to (statuses, outputs, kinds) stay strings.
    module Fields
      module_function

      def string(from, key, default = "")
        value = from[key]
        case value
        when String then value
        when Integer, Float then value.to_s
        else default
        end
      end

      def string_or_nil(from, key)
        value = from[key]
        value.is_a?(String) ? value : nil
      end

      def int(from, key, default = 0)
        int_or_nil(from, key) || default
      end

      def int_or_nil(from, key)
        value = from[key]
        case value
        when Integer then value
        when Float then value.finite? ? value.to_i : nil
        end
      end

      def float(from, key, default = 0.0)
        float_or_nil(from, key) || default
      end

      def float_or_nil(from, key)
        value = from[key]
        value.is_a?(Integer) || value.is_a?(Float) ? value.to_f : nil
      end

      def bool(from, key, default: false)
        value = from[key]
        [true, false].include?(value) ? value : default
      end

      def map(from, key)
        map_or_nil(from, key) || {}
      end

      def map_or_nil(from, key)
        value = from[key]
        value.is_a?(Hash) ? value : nil
      end

      # The entries of a list that are strings.
      def strings(from, key)
        value = from[key]
        value.is_a?(Array) ? value.grep(String) : []
      end

      # The entries of a list that are objects.
      def objects(from, key)
        value = from[key]
        value.is_a?(Array) ? value.grep(Hash) : []
      end
    end
  end
end
