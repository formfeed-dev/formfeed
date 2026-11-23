using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Formfeed.Tests.Support;
using Xunit;

namespace Formfeed.Tests;

/// <summary>
/// The SDK's half of the operations table (plan 34, decision 9): <c>operations.json</c> names a method
/// for every operation of the API, or why there is none. <c>packages/api-types/src/lib/sdk-fixtures.spec.ts</c>
/// holds the names to the API; this holds them to the client, so a renamed method fails here.
/// </summary>
public sealed class OperationsTests
{
    private static JsonElement Map()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(Paths.Package, "operations.json")));
        return document.RootElement.GetProperty("operations").Clone();
    }

    public static TheoryData<string, string> Named()
    {
        var data = new TheoryData<string, string>();
        foreach (var operation in Map().EnumerateObject())
        {
            if (operation.Value.ValueKind == JsonValueKind.String)
            {
                data.Add(operation.Name, operation.Value.GetString()!);
            }
        }
        return data;
    }

    [Fact]
    public void The_first_release_names_its_thirty_four_operations() =>
        Assert.Equal(34, Named().Count);

    [Fact]
    public void Every_operation_without_a_method_says_why_and_how_to_reach_it()
    {
        foreach (var operation in Map().EnumerateObject().Where(o => o.Value.ValueKind == JsonValueKind.Object))
        {
            var reason = operation.Value.GetProperty("none").GetString() ?? "";
            Assert.False(string.IsNullOrWhiteSpace(reason), operation.Name);
            Assert.DoesNotContain("Client::request()", reason, StringComparison.Ordinal);
        }
    }

    [Theory]
    [MemberData(nameof(Named))]
    public void The_named_method_exists(string operation, string path)
    {
        var parts = path.Split('.');
        Assert.True(parts.Length == 2, $"{operation}: {path} is not Service.Method");
        var service = typeof(FormfeedClient).GetProperty(parts[0]);
        Assert.True(service is not null, $"{operation}: no service {parts[0]}");
        var methods = service!.PropertyType.GetMethods().Where(m => m.Name == parts[1]).ToList();
        Assert.True(methods.Count > 0, $"{operation}: no method {path}");
        Assert.All(methods, m => Assert.True(typeof(Task).IsAssignableFrom(m.ReturnType), $"{path} is not async"));
    }
}
