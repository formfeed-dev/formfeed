using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>
/// A render: its status, its output's signed link and what it cost. A template, HTML, URL or
/// Markdown render, or the result of a PDF tool. <see cref="Raw"/> holds the answer as the API sent
/// it, fields of later API versions included; values such as <see cref="Status"/> stay plain
/// strings, so a new one never breaks a read.
/// </summary>
public sealed class Render : IJsonOnDeserialized
{
    /// <summary>The render id, <c>rnd_</c> and 32 hexadecimal digits.</summary>
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    /// <summary><c>queued</c>, <c>rendering</c>, <c>succeeded</c> or <c>failed</c>.</summary>
    [JsonPropertyName("status")]
    public string Status { get; set; } = "";

    /// <summary>The kind of file: <c>pdf</c>, <c>png</c>, <c>jpg</c>, <c>webp</c>, <c>docx</c>, <c>pptx</c>, <c>zip</c>, …</summary>
    [JsonPropertyName("output")]
    public string Output { get; set; } = "";

    /// <summary>The link to the file; null while queued, for a failed render and once the output is gone.</summary>
    [JsonPropertyName("download_url")]
    public string? DownloadUrl { get; set; }

    /// <summary>When <see cref="DownloadUrl"/> stops working.</summary>
    [JsonPropertyName("expires_at")]
    public DateTimeOffset? ExpiresAt { get; set; }

    /// <summary>The size of the file in bytes.</summary>
    [JsonPropertyName("bytes")]
    public long? Bytes { get; set; }

    /// <summary>The pages of a PDF; null for other outputs and while queued.</summary>
    [JsonPropertyName("page_count")]
    public int? PageCount { get; set; }

    /// <summary>The units the render cost; 0 for test keys and an answer from the dedup cache.</summary>
    [JsonPropertyName("units")]
    public double Units { get; set; }

    /// <summary>The region the render ran in, such as <c>eu</c>.</summary>
    [JsonPropertyName("region")]
    public string Region { get; set; } = "";

    /// <summary><c>live</c> or <c>test</c>.</summary>
    [JsonPropertyName("environment")]
    public string Environment { get; set; } = "";

    /// <summary>The template and version that rendered; null for HTML, URL, Markdown and PDF tool renders.</summary>
    [JsonPropertyName("template")]
    public RenderTemplate? Template { get; set; }

    /// <summary>What produced the file, for reproducibility; null until the render has succeeded.</summary>
    [JsonPropertyName("engine_version")]
    public string? EngineVersion { get; set; }

    /// <summary>The checksum of the template version that rendered.</summary>
    [JsonPropertyName("template_checksum")]
    public string? TemplateChecksum { get; set; }

    /// <summary>The SHA-256 of the output file, as hexadecimal.</summary>
    [JsonPropertyName("output_sha256")]
    public string? OutputSha256 { get; set; }

    /// <summary>True when the answer came from the dedup cache.</summary>
    [JsonPropertyName("deduplicated")]
    public bool Deduplicated { get; set; }

    /// <summary>The copy to the workspace's own bucket, if it has one.</summary>
    [JsonPropertyName("storage")]
    public JsonElement? Storage { get; set; }

    /// <summary>The e-invoice report: what was made, what the validator said and whether the PDF shows what the XML states.</summary>
    [JsonPropertyName("einvoice")]
    public JsonElement? Einvoice { get; set; }

    /// <summary>The PDF/UA-1 verdict, with <c>settings.pdf.ua</c>.</summary>
    [JsonPropertyName("accessibility")]
    public JsonElement? Accessibility { get; set; }

    /// <summary>The PDF/A verdict, with <c>settings.pdf.pdfa</c>.</summary>
    [JsonPropertyName("pdfa")]
    public JsonElement? Pdfa { get; set; }

    /// <summary>What a fill through the PDF tools did.</summary>
    [JsonPropertyName("form")]
    public JsonElement? Form { get; set; }

    /// <summary>Milliseconds per phase of a render that succeeded.</summary>
    [JsonPropertyName("timings")]
    public JsonElement? Timings { get; set; }

    /// <summary>Why a failed render failed.</summary>
    [JsonPropertyName("error")]
    public RenderError? Error { get; set; }

    /// <summary>The <c>Meta</c> of the request, unchanged.</summary>
    [JsonPropertyName("meta")]
    public IReadOnlyDictionary<string, JsonElement> Meta { get; set; } = Maps.Empty;

    /// <summary>When the render was created.</summary>
    [JsonPropertyName("created_at")]
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>When it succeeded or failed; null while queued or rendering.</summary>
    [JsonPropertyName("completed_at")]
    public DateTimeOffset? CompletedAt { get; set; }

    /// <summary>The answer as the API sent it.</summary>
    [JsonIgnore]
    public JsonElement Raw { get; internal set; }

    /// <summary>Succeeded or failed: nothing will change any more.</summary>
    [JsonIgnore]
    public bool IsFinished => Status is "succeeded" or "failed";

    /// <summary>Reads a render, also one a webhook event carries as its <c>data</c>.</summary>
    /// <exception cref="FormfeedException">with <c>invalid_response</c> when it is not a render.</exception>
    public static Render FromJson(JsonElement json)
    {
        var render = ModelReader.Read(json, FormfeedJson.Default.Render);
        render.Raw = json.Clone();
        return render;
    }

    /// <summary>Reads a render from its JSON text.</summary>
    /// <exception cref="JsonException">when the text is not JSON.</exception>
    /// <exception cref="FormfeedException">with <c>invalid_response</c> when it is not a render.</exception>
    public static Render FromJson(string json) => FromJson(ModelReader.Parse(json));

    void IJsonOnDeserialized.OnDeserialized()
    {
        Id ??= "";
        Status ??= "";
        Output ??= "";
        Region ??= "";
        Environment ??= "";
        Meta ??= Maps.Empty;
    }
}

/// <summary>The template and version a render used.</summary>
public sealed class RenderTemplate : IJsonOnDeserialized
{
    /// <summary>The template id, <c>tpl_…</c>.</summary>
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    /// <summary>The template's slug, which a render request names as <c>Template</c>.</summary>
    [JsonPropertyName("slug")]
    public string Slug { get; set; } = "";

    /// <summary>The version number that rendered.</summary>
    [JsonPropertyName("version")]
    public int Version { get; set; }

    /// <summary>The release channel the version came from; null when the request named a number or <c>latest</c>.</summary>
    [JsonPropertyName("channel")]
    public string? Channel { get; set; }

    /// <summary>True when the channel's canary share picked this version.</summary>
    [JsonPropertyName("canary")]
    public bool Canary { get; set; }

    void IJsonOnDeserialized.OnDeserialized()
    {
        Id ??= "";
        Slug ??= "";
    }
}

/// <summary>The error a failed render stored: its code, its English message and what more its problem said.</summary>
public sealed class RenderError : IJsonOnDeserialized
{
    /// <summary>The problem's code, such as <c>template_runtime_error</c>.</summary>
    [JsonPropertyName("code")]
    public string Code { get; set; } = "";

    /// <summary>The English message.</summary>
    [JsonPropertyName("message")]
    public string Message { get; set; } = "";

    /// <summary>The other members of the problem that say more, such as <c>line</c> or <c>errors</c>.</summary>
    [JsonExtensionData]
    public IDictionary<string, JsonElement>? Details { get; set; }

    void IJsonOnDeserialized.OnDeserialized()
    {
        Code ??= "";
        Message ??= "";
    }
}
