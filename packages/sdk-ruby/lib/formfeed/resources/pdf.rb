# frozen_string_literal: true

module Formfeed
  module Resources
    # The PDF tools, on the output of an earlier render (a Render or its id), a PDF of the file
    # library (a LibraryFile, its id or its name), or, for info, split, compress, to_image, redact and
    # fill, a Formfeed::Upload, which is never stored. Options go as keywords or as one Hash. Every
    # tool but info answers a new render, on the Starter plan and above: merge, protect, watermark,
    # split, compress, redact and fill cost 0.5 units each on live keys, to_image one unit per
    # picture; info is free.
    class Pdf
      def initialize(transport)
        @transport = transport
      end

      # Joins PDFs in the order given; +filename:+, +expires_in:+, ...
      def merge(sources, options = {}, idempotency_key: nil, **fields)
        body = Internal.params(options, fields).merge("sources" => sources.map { |source| Internal::Ids.of(source) })
        render("/pdf/merge", body, idempotency_key)
      end

      # Encrypts a PDF with AES-256: +user_password:+, +owner_password:+, +permissions:+.
      def protect(source, options = {}, idempotency_key: nil, **fields)
        render("/pdf/protect", stored(source, Internal.params(options, fields)), idempotency_key)
      end

      # Stamps a text or a library image on the pages.
      def watermark(source, options = {}, idempotency_key: nil, **fields)
        render("/pdf/watermark", stored(source, Internal.params(options, fields)), idempotency_key)
      end

      # Page count, page sizes, encryption, metadata and the form with every field's name, type,
      # value and options, which is how a form's names are found for +fill+. Free; creates no render.
      def info(source)
        PdfInfo.from_hash(@transport.object("POST", "/pdf/info", body(source, {})))
      end

      # Cuts a PDF into parts, +every:+ pages each or one per entry of +ranges:+: a ZIP of the parts,
      # or the PDF itself for one part.
      def split(source, options = {}, idempotency_key: nil, **fields)
        render("/pdf/split", body(source, Internal.params(options, fields)), idempotency_key)
      end

      # Makes a PDF smaller; the render keeps the source when it cannot.
      def compress(source, options = {}, idempotency_key: nil, **fields)
        render("/pdf/compress", body(source, Internal.params(options, fields)), idempotency_key)
      end

      # Draws pages as PNG or JPEG pictures (+format:+, +pages:+, +dpi:+, ...): one page answers the
      # picture, several a ZIP of them.
      def to_image(source, options = {}, idempotency_key: nil, **fields)
        render("/pdf/to-image", body(source, Internal.params(options, fields)), idempotency_key)
      end

      # Removes what lies under the rectangles (+regions:+) and every place a text stands (+text:+),
      # from the file itself, and reads the result again: text still there fails the render with
      # +redaction_incomplete+, which names regions and texts by number, never a text.
      def redact(source, options = {}, idempotency_key: nil, **fields)
        render("/pdf/redact", body(source, Internal.params(options, fields)), idempotency_key)
      end

      # Fills a form's fields by their full names (+fields:+) and keeps it fillable, or with
      # +flatten: true+ draws the values into the pages. The values are never stored.
      def fill(source, options = {}, idempotency_key: nil, **fields)
        render("/pdf/fill", body(source, Internal.params(options, fields)), idempotency_key)
      end

      # Converts an office document to a PDF render (Starter plan and above): an Upload (Word, Excel,
      # PowerPoint, OpenDocument, RTF or HTML, up to 20 MB, not kept), or the output of a Word or
      # PowerPoint template render.
      def convert(source, options = {}, idempotency_key: nil, **fields)
        options = Internal.params(options, fields)
        request = source.is_a?(Upload) ? Internal::Multipart.new(options, source) : stored(source, options)
        render("/pdf/convert", request, idempotency_key)
      end

      private

      def render(path, body, idempotency_key)
        Render.from_hash(@transport.object("POST", path, body, idempotency_key || Internal::Ids.key))
      end

      # A tool's request: a stored source by its id as JSON, an upload as multipart beside the options.
      def body(source, options)
        source.is_a?(Upload) ? Internal::Multipart.new(options, source) : stored(source, options)
      end

      def stored(source, options)
        options.merge("source" => Internal::Ids.of(source))
      end
    end
  end
end
