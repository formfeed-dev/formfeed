# frozen_string_literal: true

module Formfeed
  # A template of the workspace, without its versions' content.
  Template = Data.define(
    :id, :slug, :name, :description, :kind, :engine, :tags, :published_version, :latest_version,
    :created_at, :updated_at, :raw
  ) do
    def self.from_hash(data)
      new(
        id: Internal::Fields.string(data, "id"),
        slug: Internal::Fields.string(data, "slug"),
        name: Internal::Fields.string(data, "name"),
        description: Internal::Fields.string_or_nil(data, "description"),
        kind: Internal::Fields.string(data, "kind"),
        engine: Internal::Fields.string(data, "engine"),
        tags: Internal::Fields.strings(data, "tags"),
        published_version: Internal::Fields.int_or_nil(data, "published_version"),
        latest_version: Internal::Fields.int(data, "latest_version"),
        created_at: Internal::Fields.string(data, "created_at"),
        updated_at: Internal::Fields.string(data, "updated_at"),
        raw: data
      )
    end
  end
end
