# frozen_string_literal: true

module Formfeed
  # A batch, or a render queued with its own webhook URL: its renders in the order of the request
  # (+items+, each a Formfeed::Render) and, once they are done, a ZIP of their files (+zip_url+).
  Job = Data.define(
    :id, :type, :status, :total, :succeeded, :failed, :zip_url, :zip_expires_at, :storage, :items,
    :meta, :created_at, :completed_at, :raw
  ) do
    def self.from_hash(data)
      new(
        id: Internal::Fields.string(data, "id"),
        type: Internal::Fields.string(data, "type"),
        status: Internal::Fields.string(data, "status"),
        total: Internal::Fields.int(data, "total"),
        succeeded: Internal::Fields.int(data, "succeeded"),
        failed: Internal::Fields.int(data, "failed"),
        zip_url: Internal::Fields.string_or_nil(data, "zip_url"),
        zip_expires_at: Internal::Fields.string_or_nil(data, "zip_expires_at"),
        storage: Internal::Fields.map_or_nil(data, "storage"),
        items: Internal::Fields.objects(data, "items").map { |item| Render.from_hash(item) },
        meta: Internal::Fields.map(data, "meta"),
        created_at: Internal::Fields.string(data, "created_at"),
        completed_at: Internal::Fields.string_or_nil(data, "completed_at"),
        raw: data
      )
    end

    # No render of it is queued or running any more.
    def finished?
      !%w[queued processing].include?(status)
    end
  end
end
