using System.Collections.Generic;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>
/// One render. Name exactly one source: <see cref="Template"/>, <see cref="Html"/>, <see cref="Url"/>
/// or <see cref="Markdown"/>. What is left null is not sent, so the API's default applies.
/// </summary>
/// <remarks>
/// <see cref="Data"/>, <see cref="Settings"/>, <see cref="Meta"/> and <see cref="Post"/> are free maps:
/// their values may be strings, numbers, booleans, nested dictionaries and lists, JSON values of
/// System.Text.Json, or objects of your own (<see cref="FormfeedClientOptions.JsonSerializerOptions"/>).
/// <see cref="AdditionalFields"/> sends fields this SDK does not name yet.
/// </remarks>
public sealed class RenderRequest
{
    /// <summary>The template, by slug or id (<c>tpl_…</c>).</summary>
    public string? Template { get; set; }

    /// <summary><c>published</c> (the API's default), a release channel, <c>latest</c> (test keys) or a version number.</summary>
    public string? Version { get; set; }

    /// <summary>Ad-hoc HTML, at most 5 MB; with an <see cref="Engine"/> rendered as a template over <see cref="Data"/>.</summary>
    public string? Html { get; set; }

    /// <summary>A public https page to print.</summary>
    public string? Url { get; set; }

    /// <summary>A Markdown document, at most 1 MB.</summary>
    public string? Markdown { get; set; }

    /// <summary>The template language of <see cref="Html"/> or <see cref="Markdown"/>: <c>jinja2</c>, <c>liquid</c> or <c>handlebars</c>.</summary>
    public string? Engine { get; set; }

    /// <summary>The data the template renders with.</summary>
    public IDictionary<string, object?>? Data { get; set; }

    /// <summary><c>pdf</c>, <c>png</c>, <c>jpg</c>, <c>webp</c>, <c>docx</c> or <c>pptx</c>; the template decides when null.</summary>
    public string? Output { get; set; }

    /// <summary>Page, PDF, image and Markdown settings, layered over the template's.</summary>
    public IDictionary<string, object?>? Settings { get; set; }

    /// <summary>The name of the output file, as the download shows it.</summary>
    public string? Filename { get; set; }

    /// <summary>Seconds until the output expires; it shortens the retention and cannot lengthen it.</summary>
    public int? ExpiresIn { get; set; }

    /// <summary><c>signed</c> or <c>public</c>; the workspace's setting when null.</summary>
    public string? Access { get; set; }

    /// <summary><c>sync</c> (the default) answers the finished render, <c>async</c> answers it queued.</summary>
    public string? Mode { get; set; }

    /// <summary>The locale of a template, of HTML with an engine and of Markdown.</summary>
    public string? Locale { get; set; }

    /// <summary>Receives <c>render.completed</c> or <c>render.failed</c> for this render.</summary>
    public string? WebhookUrl { get; set; }

    /// <summary>Signs the deliveries to <see cref="WebhookUrl"/>; never returned.</summary>
    public string? WebhookSecret { get; set; }

    /// <summary>Your own data, such as an order id, returned with the render and in its webhook events.</summary>
    public IDictionary<string, object?>? Meta { get; set; }

    /// <summary><c>false</c> always renders, also when an identical request of the last 24 hours could answer.</summary>
    public bool? Dedupe { get; set; }

    /// <summary>Decides the canary split of a release channel: renders with the same value land on the same version.</summary>
    public string? CanaryKey { get; set; }

    /// <summary>Checks <see cref="Data"/> against the template's stored schema before anything is rendered.</summary>
    public bool? ValidateData { get; set; }

    /// <summary>Post-processing of a PDF: <c>einvoice</c>, <c>merge_after</c>, <c>watermark</c>, <c>password</c>.</summary>
    public IDictionary<string, object?>? Post { get; set; }

    /// <summary>The copy to the workspace's own bucket: <c>false</c>, or a map with its <c>key</c>.</summary>
    public object? Storage { get; set; }

    /// <summary>Fields this SDK does not name, sent as given (a null as JSON <c>null</c>); one of a named field's name replaces it.</summary>
    public IDictionary<string, object?>? AdditionalFields { get; set; }

    internal FieldList ToFields() => new FieldList()
        .Add("template", Template)
        .Add("version", Version)
        .Add("html", Html)
        .Add("url", Url)
        .Add("markdown", Markdown)
        .Add("engine", Engine)
        .Add("data", Data)
        .Add("output", Output)
        .Add("settings", Settings)
        .Add("filename", Filename)
        .Add("expires_in", ExpiresIn)
        .Add("access", Access)
        .Add("mode", Mode)
        .Add("locale", Locale)
        .Add("webhook_url", WebhookUrl)
        .Add("webhook_secret", WebhookSecret)
        .Add("meta", Meta)
        .Add("dedupe", Dedupe)
        .Add("canary_key", CanaryKey)
        .Add("validate_data", ValidateData)
        .Add("post", Post)
        .Add("storage", Storage)
        .SetAll(AdditionalFields);
}

/// <summary>Many renders as one job, always asynchronous; its renders keep the order of <see cref="Items"/>.</summary>
public sealed class BatchRequest
{
    /// <summary>The renders, 1 to 1,000; each item's <c>Mode</c> is ignored.</summary>
    public IList<RenderRequest> Items { get; set; } = [];

    /// <summary>The template of every item that names no source of its own.</summary>
    public string? Template { get; set; }

    /// <summary>The <c>CanaryKey</c> of every item that has none.</summary>
    public string? CanaryKey { get; set; }

    /// <summary>The <c>Output</c> of every item that has none.</summary>
    public string? Output { get; set; }

    /// <summary>Packs the succeeded outputs into one ZIP, the job's <see cref="Job.ZipUrl"/>.</summary>
    public bool? Zip { get; set; }

    /// <summary>Receives the events of every item and <c>job.completed</c> or <c>job.failed</c>.</summary>
    public string? WebhookUrl { get; set; }

    /// <summary>Signs the deliveries to <see cref="WebhookUrl"/>.</summary>
    public string? WebhookSecret { get; set; }

    /// <summary>Your own data, returned with the job and in its <c>job.*</c> events.</summary>
    public IDictionary<string, object?>? Meta { get; set; }

    /// <summary>Fields this SDK does not name, sent as given; one of a named field's name replaces it.</summary>
    public IDictionary<string, object?>? AdditionalFields { get; set; }

    internal FieldList ToFields()
    {
        var items = new List<FieldList>();
        foreach (var item in Items ?? [])
        {
            items.Add((item ?? new RenderRequest()).ToFields());
        }
        return new FieldList()
            .Add("template", Template)
            .Add("canary_key", CanaryKey)
            .Add("output", Output)
            .Add("items", items)
            .Add("zip", Zip)
            .Add("webhook_url", WebhookUrl)
            .Add("webhook_secret", WebhookSecret)
            .Add("meta", Meta)
            .SetAll(AdditionalFields);
    }
}
