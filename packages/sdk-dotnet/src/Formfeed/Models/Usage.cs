using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>The units of a billing period, with a daily series and a breakdown per template.</summary>
public sealed class Usage : IJsonOnDeserialized
{
    /// <summary>The month the period started in, <c>YYYY-MM</c>.</summary>
    [JsonPropertyName("period")]
    public string Period { get; set; } = "";

    /// <summary>The first day of the period, <c>YYYY-MM-DD</c>.</summary>
    [JsonPropertyName("period_start")]
    public string PeriodStart { get; set; } = "";

    /// <summary>The first day after the period, <c>YYYY-MM-DD</c>.</summary>
    [JsonPropertyName("period_end")]
    public string PeriodEnd { get; set; } = "";

    /// <summary>The units included in the period.</summary>
    [JsonPropertyName("included")]
    public double Included { get; set; }

    /// <summary>The units used in the period.</summary>
    [JsonPropertyName("used")]
    public double Used { get; set; }

    /// <summary>The units used beyond the included ones.</summary>
    [JsonPropertyName("overage_used")]
    public double OverageUsed { get; set; }

    /// <summary>The prepaid units from packs that are still left now.</summary>
    [JsonPropertyName("overage_balance")]
    public double OverageBalance { get; set; }

    /// <summary>The units at which overage stops live renders; null without overage and for an earlier period.</summary>
    [JsonPropertyName("hard_cap_units")]
    public double? HardCapUnits { get; set; }

    /// <summary>Units and renders per UTC day; days without renders are left out.</summary>
    [JsonIgnore]
    public IReadOnlyList<UsageDay> Daily { get; set; } = [];

    /// <summary>Units per template slug, most first.</summary>
    [JsonIgnore]
    public IReadOnlyList<UsageByTemplate> ByTemplate { get; set; } = [];

    /// <summary>The answer as the API sent it.</summary>
    [JsonIgnore]
    public JsonElement Raw { get; internal set; }

    /// <summary>Reads the usage of a period.</summary>
    /// <exception cref="FormfeedException">with <c>invalid_response</c> when it is not one.</exception>
    public static Usage FromJson(JsonElement json)
    {
        var usage = ModelReader.Read(json, FormfeedJson.Default.Usage);
        usage.Daily = ModelReader.Objects(json, "daily", day => ModelReader.Read(day, FormfeedJson.Default.UsageDay));
        usage.ByTemplate = ModelReader.Objects(
            json,
            "by_template",
            item => ModelReader.Read(item, FormfeedJson.Default.UsageByTemplate));
        usage.Raw = json.Clone();
        return usage;
    }

    void IJsonOnDeserialized.OnDeserialized()
    {
        Period ??= "";
        PeriodStart ??= "";
        PeriodEnd ??= "";
    }
}

/// <summary>The units and renders of one UTC day.</summary>
public sealed class UsageDay : IJsonOnDeserialized
{
    /// <summary>The day, <c>YYYY-MM-DD</c>.</summary>
    [JsonPropertyName("date")]
    public string Date { get; set; } = "";

    /// <summary>The units of the day.</summary>
    [JsonPropertyName("units")]
    public double Units { get; set; }

    /// <summary>The renders of the day, test renders included, which cost no unit.</summary>
    [JsonPropertyName("renders")]
    public int Renders { get; set; }

    void IJsonOnDeserialized.OnDeserialized() => Date ??= "";
}

/// <summary>The units of one template in a period.</summary>
public sealed class UsageByTemplate : IJsonOnDeserialized
{
    /// <summary>The template's slug, or the source of renders without one (<c>html</c>, <c>url</c>, <c>markdown</c>, <c>pdf_tool</c>).</summary>
    [JsonPropertyName("template")]
    public string Template { get; set; } = "";

    /// <summary>Its units.</summary>
    [JsonPropertyName("units")]
    public double Units { get; set; }

    void IJsonOnDeserialized.OnDeserialized() => Template ??= "";
}

/// <summary>
/// What a PDF holds: its pages and their sizes, whether it is encrypted, its metadata, and its form
/// with every field's full name, the names <see cref="PdfService.FillAsync"/> takes.
/// </summary>
public sealed class PdfInfo : IJsonOnDeserialized
{
    /// <summary>The source: the render id, or the library file's name.</summary>
    [JsonPropertyName("source")]
    public string Source { get; set; } = "";

    /// <summary>The number of pages.</summary>
    [JsonPropertyName("page_count")]
    public int PageCount { get; set; }

    /// <summary>The size of every page.</summary>
    [JsonIgnore]
    public IReadOnlyList<PdfPage> Pages { get; set; } = [];

    /// <summary>Whether the file is password-protected.</summary>
    [JsonPropertyName("encrypted")]
    public bool Encrypted { get; set; }

    /// <summary>The document properties: <c>title</c>, <c>author</c>, <c>subject</c>, <c>producer</c>, <c>creator</c>.</summary>
    [JsonPropertyName("metadata")]
    public IReadOnlyDictionary<string, JsonElement> Metadata { get; set; } = Maps.Empty;

    /// <summary>The form, its fields with name, type, value and options; null when the file needs a password.</summary>
    [JsonPropertyName("form")]
    public JsonElement? Form { get; set; }

    /// <summary>The answer as the API sent it.</summary>
    [JsonIgnore]
    public JsonElement Raw { get; internal set; }

    /// <summary>Reads what a PDF holds.</summary>
    /// <exception cref="FormfeedException">with <c>invalid_response</c> when it is not that.</exception>
    public static PdfInfo FromJson(JsonElement json)
    {
        var info = ModelReader.Read(json, FormfeedJson.Default.PdfInfo);
        info.Pages = ModelReader.Objects(json, "pages", page => ModelReader.Read(page, FormfeedJson.Default.PdfPage));
        info.Raw = json.Clone();
        return info;
    }

    void IJsonOnDeserialized.OnDeserialized()
    {
        Source ??= "";
        Metadata ??= Maps.Empty;
    }
}

/// <summary>The size of a page, in points (1/72 inch) and millimetres.</summary>
public sealed class PdfPage
{
    /// <summary>The width in points.</summary>
    [JsonPropertyName("width_pt")]
    public double WidthPt { get; set; }

    /// <summary>The height in points.</summary>
    [JsonPropertyName("height_pt")]
    public double HeightPt { get; set; }

    /// <summary>The width in millimetres.</summary>
    [JsonPropertyName("width_mm")]
    public double WidthMm { get; set; }

    /// <summary>The height in millimetres.</summary>
    [JsonPropertyName("height_mm")]
    public double HeightMm { get; set; }
}

/// <summary>
/// A verified webhook delivery: <see cref="Webhook.Parse(string, string, string, TimeSpan?, DateTimeOffset?)"/>
/// answers it. For <c>render.*</c> events <see cref="Data"/> is the render, which
/// <see cref="Render.FromJson(JsonElement)"/> reads; for <c>job.*</c> events the job.
/// </summary>
public sealed class WebhookEvent : IJsonOnDeserialized
{
    /// <summary>The event id, <c>evt_…</c>.</summary>
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    /// <summary>The event, such as <c>render.completed</c>.</summary>
    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    /// <summary>When it happened.</summary>
    [JsonPropertyName("created_at")]
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>The workspace it happened in.</summary>
    [JsonPropertyName("workspace_id")]
    public string? WorkspaceId { get; set; }

    /// <summary>What the event is about: the render, the job, or the quota.</summary>
    [JsonPropertyName("data")]
    public JsonElement Data { get; set; }

    /// <summary>The event as it was delivered.</summary>
    [JsonIgnore]
    public JsonElement Raw { get; internal set; }

    /// <summary>Reads an event; check its signature first with <see cref="Webhook"/>.</summary>
    /// <exception cref="FormfeedException">with <c>invalid_response</c> when it is not an event.</exception>
    public static WebhookEvent FromJson(JsonElement json)
    {
        var webhookEvent = ModelReader.Read(json, FormfeedJson.Default.WebhookEvent);
        webhookEvent.Raw = json.Clone();
        return webhookEvent;
    }

    void IJsonOnDeserialized.OnDeserialized()
    {
        Id ??= "";
        Type ??= "";
    }
}
