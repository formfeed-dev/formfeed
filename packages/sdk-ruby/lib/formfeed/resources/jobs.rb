# frozen_string_literal: true

module Formfeed
  module Resources
    # Jobs: a batch, or a render queued with its own webhook URL.
    class Jobs
      def initialize(transport)
        @transport = transport
      end

      def get(job)
        Job.from_hash(@transport.object("GET", "/jobs/#{Internal::Ids.path(job)}"))
      end

      # Polls until no render of the job is queued or running, at most +timeout+ seconds.
      def wait_for(job, timeout: 600, interval: 2)
        id = Internal::Ids.of(job)
        Internal.poll(@transport, timeout, interval, "job #{id}") { get(id) }
      end
    end
  end
end
