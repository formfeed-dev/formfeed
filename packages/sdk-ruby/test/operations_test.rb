# frozen_string_literal: true

require "test_helper"

# The SDK's half of the operations table (plan 34, decision 9): operations.json names a method for
# every operation of the API, or why there is none. packages/api-types/src/lib/sdk-fixtures.spec.ts
# holds the names to the API; this holds them to the client, so a renamed method fails here.
class OperationsTest < FormfeedTest::TestCase
  MAP = JSON.parse(File.read(File.join(FormfeedTest::PACKAGE, "operations.json"))).fetch("operations")
  NAMED = MAP.select { |_, path| path.is_a?(String) }

  def test_the_first_release_names_its_thirty_four_operations
    assert_equal 34, NAMED.size
  end

  def test_the_others_say_why_they_have_none
    MAP.each do |operation, value|
      next if value.is_a?(String)

      refute_empty value.fetch("none").strip, operation
    end
  end

  NAMED.each do |operation, path|
    define_method("test_#{operation} is #{path}") do
      service, method = path.split(".", 2)

      assert Formfeed::Client.public_method_defined?(service), "#{operation}: no service #{service}"
      resource = client.public_send(service)

      assert_includes resource.class.public_instance_methods(false), method.to_sym, "#{operation}: no method #{path}"
    end
  end
end
