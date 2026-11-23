# frozen_string_literal: true

module Formfeed
  # A problem the API answered (RFC 9457), as Formfeed::Error#problem carries it. +type+ names the
  # page that explains the code; +location+, +errors+, +issues+ and +field+ appear with the codes
  # that have them; +raw+ is the whole document, members of later API versions included, and
  # +problem["period_end"]+ reads any member of it.
  Problem = Data.define(
    :type, :title, :status, :detail, :code, :request_id, :location, :errors, :issues, :field, :raw
  ) do
    def self.from_hash(data)
      new(
        type: Internal::Fields.string(data, "type"),
        title: Internal::Fields.string(data, "title"),
        status: Internal::Fields.int_or_nil(data, "status"),
        detail: Internal::Fields.string(data, "detail"),
        code: Internal::Fields.string(data, "code"),
        request_id: Internal::Fields.string_or_nil(data, "request_id"),
        location: Internal::Fields.map_or_nil(data, "location"),
        errors: Internal::Fields.objects(data, "errors"),
        issues: Internal::Fields.objects(data, "issues"),
        field: Internal::Fields.string_or_nil(data, "field"),
        raw: data
      )
    end

    # A member of the document by its name.
    def [](member)
      raw[member.to_s]
    end
  end
end
