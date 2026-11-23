# frozen_string_literal: true

require "test_helper"

# The contract goldens (plan 25 §5.3): what the API answers today, written by the gateway's
# contract.spec.ts. Each is read with the model its name starts with, so a change of an answer that
# the SDK cannot read fails here before it ships. They live in the Formfeed repository only; the
# public repository carries the shared vectors without them, and skips these tests.
class GoldensTest < Minitest::Test
  FILES = Dir.glob(File.join(FormfeedTest::CONTRACT, "*.json"))

  def test_there_are_goldens
    unless File.directory?(FormfeedTest::CONTRACT)
      skip "outside the Formfeed repository, which holds the contract goldens"
    end

    refute_empty FILES
  end

  FILES.each do |file|
    name = File.basename(file, ".json")
    define_method("test_the_sdk_reads #{name}.json") do
      data = JSON.parse(File.read(file))

      assert_kind_of Hash, data
      read(name, data)
    end
  end

  private

  def read(name, data)
    if prefixed?(name, "render-page")
      page = Formfeed::Page.from_hash(data, Formfeed::Render)

      refute_empty page.data
      page.each { |render| assert render.id.start_with?("rnd_"), render.id }
    elsif prefixed?(name, "render-input")
      assert Formfeed::RenderInput.from_hash(data).render_id.start_with?("rnd_")
    elsif name.start_with?("render")
      read_render(data)
    elsif name.start_with?("job")
      read_job(data)
    else
      flunk "#{name}.json: no model is named for this file"
    end
  end

  def read_render(data)
    render = Formfeed::Render.from_hash(data)

    assert render.id.start_with?("rnd_"), render.id
    refute_empty render.status
  end

  def read_job(data)
    job = Formfeed::Job.from_hash(data)

    assert job.id.start_with?("job_"), job.id
    assert_equal job.total, job.items.size
  end

  def prefixed?(name, prefix)
    name == prefix || name.start_with?("#{prefix}-")
  end
end
