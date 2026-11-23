# frozen_string_literal: true

module Formfeed
  module Resources
    # The workspace's file library: images and PDFs a template names with +asset('logo.png')+, and
    # the sources of image watermarks and merges. Needs +file:read+, +file:write+ or +file:delete+.
    # Files are served without a signature, so keep confidential documents out of it.
    class Files
      def initialize(transport)
        @transport = transport
      end

      # Uploads a Formfeed::Upload; one of the same name is replaced in place and keeps its URL.
      def upload(file)
        LibraryFile.from_hash(
          @transport.object("POST", "/files", Internal::Multipart.new({ "name" => file.name }, file))
        )
      end

      # One page of files, newest first: +prefix:+ keeps the names that start with it, +limit:+,
      # +cursor:+.
      def list(query = {}, **fields)
        Page.from_hash(
          @transport.object("GET", "/files#{Internal::Query.string(Internal.params(query, fields))}"), LibraryFile
        )
      end

      # Every file the query matches, page by page as it is iterated.
      def all(query = {}, **fields, &)
        params = Internal.params(query, fields)
        files = Internal.pages { |cursor| list(params.merge("cursor" => cursor)) }
        block_given? ? files.each(&) : files
      end

      # A file by its id (+fil_...+).
      def get(file)
        LibraryFile.from_hash(@transport.object("GET", "/files/#{Internal::Ids.path(file)}"))
      end

      # Removes the file and its bytes; templates that name it render a missing image afterwards.
      def delete(file)
        @transport.json("DELETE", "/files/#{Internal::Ids.path(file)}")
        nil
      end
    end
  end
end
