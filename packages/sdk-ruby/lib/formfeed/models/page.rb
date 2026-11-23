# frozen_string_literal: true

module Formfeed
  # One page of a list, newest first, and the cursor of the next (nil on the last). It enumerates
  # its items, so +page.map(&:id)+ works; the +all+ methods follow the cursor through every page.
  class Page
    include Enumerable

    attr_reader :data, :next_cursor

    def initialize(data:, next_cursor:)
      @data = data.freeze
      @next_cursor = next_cursor
      freeze
    end

    # A page of the answer +page+, each item read with +model+ (a class with +from_hash+).
    def self.from_hash(page, model)
      new(
        data: Internal::Fields.objects(page, "data").map { |item| model.from_hash(item) },
        next_cursor: Internal::Fields.string_or_nil(page, "next_cursor")
      )
    end

    def each(&)
      return enum_for(:each) unless block_given?

      @data.each(&)
      self
    end

    def size
      @data.size
    end

    def empty?
      @data.empty?
    end

    # Whether no page follows this one.
    def last?
      @next_cursor.nil?
    end

    def inspect
      "#<#{self.class.name} #{@data.size} items, next_cursor=#{@next_cursor.inspect}>"
    end
  end
end
