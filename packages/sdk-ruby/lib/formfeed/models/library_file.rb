# frozen_string_literal: true

module Formfeed
  # A file of the workspace's library: an image or PDF a template names, served at +url+.
  LibraryFile = Data.define(
    :id, :name, :content_type, :bytes, :sha256, :url, :created_at, :updated_at, :raw
  ) do
    def self.from_hash(data)
      new(
        id: Internal::Fields.string(data, "id"),
        name: Internal::Fields.string(data, "name"),
        content_type: Internal::Fields.string(data, "content_type"),
        bytes: Internal::Fields.int(data, "bytes"),
        sha256: Internal::Fields.string(data, "sha256"),
        url: Internal::Fields.string(data, "url"),
        created_at: Internal::Fields.string(data, "created_at"),
        updated_at: Internal::Fields.string(data, "updated_at"),
        raw: data
      )
    end
  end
end
