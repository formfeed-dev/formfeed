# frozen_string_literal: true

module Formfeed
  # What a PDF holds: its pages and their sizes (+pages+: width_pt, height_pt, width_mm and
  # height_mm of each), whether it is encrypted, its metadata, and its form (+form+: the fields, each
  # with name, type, value and options, by the full names +pdf.fill+ takes).
  PdfInfo = Data.define(:source, :page_count, :pages, :encrypted, :metadata, :form, :raw) do
    def self.from_hash(data)
      new(
        source: Internal::Fields.string(data, "source"),
        page_count: Internal::Fields.int(data, "page_count"),
        pages: Internal::Fields.objects(data, "pages"),
        encrypted: Internal::Fields.bool(data, "encrypted"),
        metadata: Internal::Fields.map(data, "metadata"),
        form: Internal::Fields.map_or_nil(data, "form"),
        raw: data
      )
    end
  end
end
