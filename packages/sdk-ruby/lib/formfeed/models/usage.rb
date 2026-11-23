# frozen_string_literal: true

module Formfeed
  # The units of a billing period, with a daily series (+daily+: date, units and renders of each day)
  # and a breakdown per template (+by_template+: template and units).
  Usage = Data.define(
    :period, :period_start, :period_end, :included, :used, :overage_used, :overage_balance,
    :hard_cap_units, :daily, :by_template, :raw
  ) do
    def self.from_hash(data)
      new(
        period: Internal::Fields.string(data, "period"),
        period_start: Internal::Fields.string(data, "period_start"),
        period_end: Internal::Fields.string(data, "period_end"),
        included: Internal::Fields.float(data, "included"),
        used: Internal::Fields.float(data, "used"),
        overage_used: Internal::Fields.float(data, "overage_used"),
        overage_balance: Internal::Fields.float(data, "overage_balance"),
        hard_cap_units: Internal::Fields.float_or_nil(data, "hard_cap_units"),
        daily: Internal::Fields.objects(data, "daily"),
        by_template: Internal::Fields.objects(data, "by_template"),
        raw: data
      )
    end
  end
end
