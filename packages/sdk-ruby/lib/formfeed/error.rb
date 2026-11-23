# frozen_string_literal: true

module Formfeed
  # An API problem (RFC 9457) or a failure on this side.
  #
  # +code+ is the problem's code (+quota_exceeded+, +template_not_found+, ...), or +network_error+,
  # +timeout+, +not_ready+, +download_failed+ or +invalid_response+ for what went wrong before an
  # answer; +status+ is the HTTP status, 0 when there was none; +problem+ the problem document as a
  # Formfeed::Problem; +request_id+ the +X-Request-Id+ the API answered with, which support asks for.
  class Error < StandardError
    attr_reader :code, :status, :problem, :request_id

    def initialize(code, message, status: 0, problem: nil, request_id: nil)
      super(message)
      @code = code
      @status = status
      @problem = problem
      @request_id = request_id
    end
  end
end
