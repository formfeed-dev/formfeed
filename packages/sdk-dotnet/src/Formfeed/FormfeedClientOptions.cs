using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Formfeed;

/// <summary>How a <see cref="FormfeedClient"/> reaches the API.</summary>
public sealed class FormfeedClientOptions
{
    /// <summary>The API key, <c>ff_live_…</c> or <c>ff_test_…</c>.</summary>
    public string ApiKey { get; set; } = "";

    /// <summary><c>eu</c> (the default) or <c>us</c>; ignored when <see cref="BaseUrl"/> is set.</summary>
    public string Region { get; set; } = "eu";

    /// <summary>The full base address with <c>/v1</c>, for a local or another gateway.</summary>
    public Uri? BaseUrl { get; set; }

    /// <summary>Retries on 429, 503 and network errors; 0 turns them off. 3 by default.</summary>
    public int MaxRetries { get; set; } = 3;

    /// <summary>
    /// The time limit of one attempt and of a download, 120 seconds by default; a time limit that
    /// runs out is a network error, which is retried. An <see cref="System.Net.Http.HttpClient"/> you
    /// pass keeps its own <c>Timeout</c> as well (100 seconds by default), so give it more than this one.
    /// </summary>
    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(120);

    /// <summary>Headers sent with every request, after the SDK's own, which they replace.</summary>
    public IDictionary<string, string> Headers { get; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// How values of <c>Data</c>, <c>Settings</c> and the other free maps are written when they are
    /// objects of your own rather than dictionaries, lists and JSON values. In an application
    /// trimmed or compiled ahead of time, give options whose resolver knows those types (your own
    /// <c>JsonSerializerContext</c>); elsewhere the default options serve.
    /// </summary>
    public JsonSerializerOptions? JsonSerializerOptions { get; set; }

    /// <summary>How to wait between retries and polls; <see cref="Task.Delay(TimeSpan, CancellationToken)"/> by default. Tests record the waits instead.</summary>
    public Func<TimeSpan, CancellationToken, Task>? Delay { get; set; }

    /// <summary>The share of the 250 ms of jitter a retry waits on top, from 0 to 1; random by default. Tests fix it.</summary>
    public Func<double>? Jitter { get; set; }
}
