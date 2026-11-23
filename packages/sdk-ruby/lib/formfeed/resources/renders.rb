# frozen_string_literal: true

module Formfeed
  module Resources
    # Renders: create one, follow it, download its file, list them, render many as a batch.
    class Renders
      def initialize(transport)
        @transport = transport
      end

      # Renders a template, HTML, a URL or Markdown: +template:+ with +data:+, or +html:+, +url:+ or
      # +markdown:+, and +output:+, +settings:+, ... as keywords or as one Hash. Sync by default, so
      # the answer is the finished render; +mode: "async"+ answers it queued. A retry of the same
      # call sends the same Idempotency-Key, generated unless you pass one, so it cannot charge twice.
      def create(request = {}, idempotency_key: nil, **fields)
        Render.from_hash(@transport.object("POST", "/renders", Internal.params(request, fields),
                                           idempotency_key || Internal::Ids.key))
      end

      def get(render)
        Render.from_hash(@transport.object("GET", "/renders/#{Internal::Ids.path(render)}"))
      end

      # One page of renders, newest first: +template:+, +status:+, +environment:+, +since:+,
      # +until:+, +limit:+ and +cursor:+.
      def list(query = {}, **fields)
        Page.from_hash(
          @transport.object("GET", "/renders#{Internal::Query.string(Internal.params(query, fields))}"), Render
        )
      end

      # Every render the query matches, page by page as it is iterated: an Enumerator, or with a block
      # each render in turn.
      def all(query = {}, **fields, &)
        params = Internal.params(query, fields)
        renders = Internal.pages { |cursor| list(params.merge("cursor" => cursor)) }
        block_given? ? renders.each(&) : renders
      end

      # Removes the stored files of a render before they expire. Needs the +file:delete+ scope.
      def delete_outputs(render)
        @transport.json("DELETE", "/renders/#{Internal::Ids.path(render)}/outputs")
        nil
      end

      # The stored request of a render, to render it again. Needs +render:input+; answers
      # +render_input_expired+ (410) when the workspace keeps no requests or the period ended.
      def input(render)
        RenderInput.from_hash(@transport.object("GET", "/renders/#{Internal::Ids.path(render)}/input"))
      end

      # Queues many renders as one job: +items:+, and +template:+, +output:+, +zip:+, ... shared by
      # them; its renders keep the order of +items+.
      def batch(request = {}, idempotency_key: nil, **fields)
        Job.from_hash(@transport.object("POST", "/renders/batch", Internal.params(request, fields),
                                        idempotency_key || Internal::Ids.key))
      end

      # Polls until the render succeeded or failed (an async one), at most +timeout+ seconds.
      def wait_for(render, timeout: 120, interval: 1)
        id = Internal::Ids.of(render)
        Internal.poll(@transport, timeout, interval, "render #{id}") { get(id) }
      end

      # The output of a finished render (a Render or its id), as binary bytes.
      def download(render)
        @transport.download(download_url(render))
      end

      # Writes the output of a finished render to a path or an IO, streaming it; answers the bytes
      # written.
      def download_to(render, target)
        @transport.download(download_url(render), target)
      end

      private

      def download_url(render)
        target = render.is_a?(String) ? get(render) : render
        return target.download_url unless target.download_url.nil?

        raise Error.new("not_ready", "render #{target.id} has no output (#{target.status})")
      end
    end
  end
end
