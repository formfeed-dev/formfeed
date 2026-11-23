# frozen_string_literal: true

module Formfeed
  # A render: its status, its output's signed link and what it cost. +raw+ holds the answer as the
  # API sent it, fields of later API versions included. +template+ (id, slug, version, and channel
  # and canary where they apply), +storage+, +einvoice+, +accessibility+, +pdfa+, +form+, +timings+
  # and +error+ are hashes as the API sends them, or nil.
  Render = Data.define(
    :id, :status, :output, :download_url, :expires_at, :bytes, :page_count, :units, :region,
    :environment, :template, :engine_version, :output_sha256, :deduplicated, :storage, :einvoice,
    :accessibility, :pdfa, :form, :timings, :error, :meta, :created_at, :completed_at, :raw
  ) do
    def self.from_hash(data) # rubocop:disable Metrics/MethodLength
      new(
        id: Internal::Fields.string(data, "id"),
        status: Internal::Fields.string(data, "status"),
        output: Internal::Fields.string(data, "output"),
        download_url: Internal::Fields.string_or_nil(data, "download_url"),
        expires_at: Internal::Fields.string_or_nil(data, "expires_at"),
        bytes: Internal::Fields.int_or_nil(data, "bytes"),
        page_count: Internal::Fields.int_or_nil(data, "page_count"),
        units: Internal::Fields.float(data, "units"),
        region: Internal::Fields.string(data, "region"),
        environment: Internal::Fields.string(data, "environment"),
        template: Internal::Fields.map_or_nil(data, "template"),
        engine_version: Internal::Fields.string_or_nil(data, "engine_version"),
        output_sha256: Internal::Fields.string_or_nil(data, "output_sha256"),
        deduplicated: Internal::Fields.bool(data, "deduplicated"),
        storage: Internal::Fields.map_or_nil(data, "storage"),
        einvoice: Internal::Fields.map_or_nil(data, "einvoice"),
        accessibility: Internal::Fields.map_or_nil(data, "accessibility"),
        pdfa: Internal::Fields.map_or_nil(data, "pdfa"),
        form: Internal::Fields.map_or_nil(data, "form"),
        timings: Internal::Fields.map_or_nil(data, "timings"),
        error: Internal::Fields.map_or_nil(data, "error"),
        meta: Internal::Fields.map(data, "meta"),
        created_at: Internal::Fields.string(data, "created_at"),
        completed_at: Internal::Fields.string_or_nil(data, "completed_at"),
        raw: data
      )
    end

    # Succeeded or failed: nothing will change any more.
    def finished?
      %w[succeeded failed].include?(status)
    end
  end
end
