using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using Formfeed.Tests.Support;
using Xunit;

namespace Formfeed.Tests;

/// <summary>
/// The contract goldens (plan 25 §5.3): what the API answers today, written by the gateway's
/// <c>contract.spec.ts</c>. Each is read with the model its name starts with, so a change of an answer
/// that the SDK cannot read fails here before it ships. They live in the Formfeed repository only;
/// the public repository carries the shared vectors without them, and skips these tests.
/// </summary>
public sealed class GoldensTests
{
    private const string Outside = "outside the Formfeed repository, which holds the contract goldens";

    public static TheoryData<string> Goldens()
    {
        var data = new TheoryData<string>();
        if (Directory.Exists(Paths.Goldens))
        {
            foreach (var file in Directory.GetFiles(Paths.Goldens, "*.json").OrderBy(f => f, StringComparer.Ordinal))
            {
                data.Add(Path.GetFileName(file));
            }
        }
        // a theory may not be empty: outside the repository, one case that skips
        if (data.Count == 0)
        {
            data.Add("");
        }
        return data;
    }

    [Fact]
    public void There_are_goldens()
    {
        Assert.SkipUnless(Directory.Exists(Paths.Goldens), Outside);
        Assert.NotEmpty(Directory.GetFiles(Paths.Goldens, "*.json"));
    }

    [Theory]
    [MemberData(nameof(Goldens))]
    public void The_sdk_reads_the_golden(string file)
    {
        Assert.SkipWhen(file.Length == 0, Outside);
        var text = File.ReadAllText(Path.Combine(Paths.Goldens, file));
        var name = Path.GetFileNameWithoutExtension(file);

        if (Is(name, "render-page"))
        {
            using var document = JsonDocument.Parse(text);
            var page = Page.FromJson(document.RootElement, Render.FromJson);
            Assert.NotEmpty(page.Data);
            Assert.All(page.Data, render => Assert.StartsWith("rnd_", render.Id, StringComparison.Ordinal));
        }
        else if (Is(name, "render-input"))
        {
            Assert.StartsWith("rnd_", RenderInput.FromJson(text).RenderId, StringComparison.Ordinal);
        }
        else if (name.StartsWith("render", StringComparison.Ordinal))
        {
            var render = Render.FromJson(text);
            Assert.StartsWith("rnd_", render.Id, StringComparison.Ordinal);
            Assert.NotEqual("", render.Status);
            Assert.NotEqual(default, render.CreatedAt);
        }
        else if (name.StartsWith("job", StringComparison.Ordinal))
        {
            var job = Job.FromJson(text);
            Assert.StartsWith("job_", job.Id, StringComparison.Ordinal);
            Assert.Equal(job.Total, job.Items.Count);
            Assert.All(job.Items, item => Assert.StartsWith("rnd_", item.Id, StringComparison.Ordinal));
        }
        else
        {
            Assert.Fail($"{file}: no model is named for this file");
        }
    }

    private static bool Is(string name, string prefix) =>
        name == prefix || name.StartsWith(prefix + "-", StringComparison.Ordinal);
}
