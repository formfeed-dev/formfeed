# frozen_string_literal: true

module Formfeed
  module Resources
    # The workspace's templates, read and checked. Writing them (versions, publishing, channels) is
    # the command line's and the app's; Formfeed::Client#request reaches those calls.
    class Templates
      def initialize(transport)
        @transport = transport
      end

      # One page of templates: +kind:+, +engine:+, +tag:+, +q:+, +limit:+, +cursor:+.
      def list(query = {}, **fields)
        Page.from_hash(
          @transport.object("GET", "/templates#{Internal::Query.string(Internal.params(query, fields))}"), Template
        )
      end

      # Every template the query matches, page by page as it is iterated.
      def all(query = {}, **fields, &)
        params = Internal.params(query, fields)
        templates = Internal.pages { |cursor| list(params.merge("cursor" => cursor)) }
        block_given? ? templates.each(&) : templates
      end

      # A template by its slug, +tpl_...+ id or UUID.
      def get(id_or_slug)
        Template.from_hash(@transport.object("GET", "/templates/#{Internal.escape(id_or_slug)}"))
      end

      # The JSON Schema of the template's data, as a Hash: stored, else inferred from the sample data.
      # Of the published (else the latest) version, or of +version+: +published+, +latest+, a number
      # or a channel name.
      def schema(id_or_slug, version: nil)
        @transport.object(
          "GET", "/templates/#{Internal.escape(id_or_slug)}/schema#{Internal::Query.string("version" => version)}"
        )
      end

      # Checks a version with data without rendering: syntax, header and footer, missing partials,
      # runtime errors and the data against the stored schema. Free. +version:+ and +data:+; without
      # +data+, the version's sample data is checked. Answers +valid+ and the +errors+ and
      # +warnings+ found.
      def validate(id_or_slug, input = {}, **fields)
        @transport.object("POST", "/templates/#{Internal.escape(id_or_slug)}/validate", Internal.params(input, fields))
      end
    end
  end
end
