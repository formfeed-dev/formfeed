# frozen_string_literal: true

module Formfeed
  # A file sent with a request: a PDF for the PDF tools, an office document to convert, an e-invoice
  # to validate, a file for the library. It is read into memory and sent as multipart; the API keeps
  # only what the library stores.
  class Upload
    TYPES = {
      "pdf" => "application/pdf",
      "xml" => "application/xml",
      "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "odt" => "application/vnd.oasis.opendocument.text",
      "ods" => "application/vnd.oasis.opendocument.spreadsheet",
      "odp" => "application/vnd.oasis.opendocument.presentation",
      "rtf" => "application/rtf",
      "html" => "text/html",
      "htm" => "text/html",
      "png" => "image/png",
      "jpg" => "image/jpeg",
      "jpeg" => "image/jpeg",
      "webp" => "image/webp",
      "gif" => "image/gif",
      "svg" => "image/svg+xml"
    }.freeze

    attr_reader :contents, :name, :content_type

    def initialize(contents, name, content_type = nil)
      @contents = contents.b.freeze
      @name = name.to_s.freeze
      @content_type = (content_type || self.class.type_of(@name)).freeze
      freeze
    end

    # A file on disk; +name+ is its file name unless given.
    def self.from_path(path, name: nil, content_type: nil)
      raise ArgumentError, "cannot read #{path}" unless File.file?(path) && File.readable?(path)

      new(File.binread(path), name || File.basename(path), content_type)
    end

    # Bytes held in memory, under the name the API is to see.
    def self.from_string(contents, name, content_type: nil)
      new(contents, name, content_type)
    end

    # What an IO holds from where it stands: a File, a StringIO, or an upload a Rails or Rack
    # application received, whose +original_filename+ and +content_type+ are taken where given.
    def self.from_io(io, name: nil, content_type: nil)
      name ||= name_of(io)
      raise ArgumentError, "name is required for an IO without a file name" if name.nil? || name.to_s.empty?

      content_type ||= io.content_type if io.respond_to?(:content_type)
      new(io.read.to_s, name, content_type)
    end

    def self.name_of(io)
      return io.original_filename if io.respond_to?(:original_filename)

      File.basename(io.path) if io.respond_to?(:path) && io.path
    end
    private_class_method :name_of

    # What the name says the file is; the API reads the format from the bytes either way.
    def self.type_of(name)
      TYPES.fetch(File.extname(name).delete_prefix(".").downcase, "application/octet-stream")
    end

    def inspect
      "#<#{self.class.name} #{@name} (#{@content_type}, #{@contents.bytesize} bytes)>"
    end
  end
end
