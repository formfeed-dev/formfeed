# frozen_string_literal: true

module Formfeed
  # A registered webhook endpoint. +secret+ is only in the answer that created it.
  WebhookEndpoint = Data.define(
    :id, :url, :events, :environments, :enabled, :description, :consecutive_failures, :secret,
    :created_at, :updated_at, :raw
  ) do
    def self.from_hash(data)
      new(
        id: Internal::Fields.string(data, "id"),
        url: Internal::Fields.string(data, "url"),
        events: Internal::Fields.strings(data, "events"),
        environments: Internal::Fields.strings(data, "environments"),
        enabled: Internal::Fields.bool(data, "enabled", default: true),
        description: Internal::Fields.string_or_nil(data, "description"),
        consecutive_failures: Internal::Fields.int(data, "consecutive_failures"),
        secret: Internal::Fields.string_or_nil(data, "secret"),
        created_at: Internal::Fields.string(data, "created_at"),
        updated_at: Internal::Fields.string(data, "updated_at"),
        raw: data
      )
    end
  end
end
