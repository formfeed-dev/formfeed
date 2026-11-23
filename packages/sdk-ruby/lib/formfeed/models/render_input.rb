# frozen_string_literal: true

module Formfeed
  # The stored request of a render, to render it again: a template render carries +template+ and
  # +data+, an ad-hoc one +html+, +url+ or +markdown+. Passwords are never included.
  RenderInput = Data.define(
    :render_id, :template, :data, :html, :markdown, :url, :engine, :locale, :output, :settings,
    :filename, :post, :meta, :environment, :created_at, :raw
  ) do
    def self.from_hash(data)
      new(
        render_id: Internal::Fields.string(data, "render_id"),
        template: Internal::Fields.map_or_nil(data, "template"),
        data: Internal::Fields.map_or_nil(data, "data"),
        html: Internal::Fields.string_or_nil(data, "html"),
        markdown: Internal::Fields.string_or_nil(data, "markdown"),
        url: Internal::Fields.string_or_nil(data, "url"),
        engine: Internal::Fields.string_or_nil(data, "engine"),
        locale: Internal::Fields.string_or_nil(data, "locale"),
        output: Internal::Fields.string_or_nil(data, "output"),
        settings: Internal::Fields.map_or_nil(data, "settings"),
        filename: Internal::Fields.string_or_nil(data, "filename"),
        post: Internal::Fields.map_or_nil(data, "post"),
        meta: Internal::Fields.map(data, "meta"),
        environment: Internal::Fields.string(data, "environment"),
        created_at: Internal::Fields.string(data, "created_at"),
        raw: data
      )
    end
  end
end
