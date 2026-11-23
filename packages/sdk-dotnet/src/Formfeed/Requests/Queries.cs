using System;
using System.Collections.Generic;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>Which renders a list holds, newest first. What is left null does not filter.</summary>
public sealed class RenderListQuery
{
    /// <summary>Only renders of this template: its slug, its id (<c>tpl_…</c>) or its UUID.</summary>
    public string? Template { get; set; }

    /// <summary>Only renders in this state: <c>queued</c>, <c>rendering</c>, <c>succeeded</c> or <c>failed</c>.</summary>
    public string? Status { get; set; }

    /// <summary>Only renders of live keys (<c>live</c>) or of test keys (<c>test</c>).</summary>
    public string? Environment { get; set; }

    /// <summary>Only renders created at or after this time.</summary>
    public DateTimeOffset? Since { get; set; }

    /// <summary>Only renders created at or before this time.</summary>
    public DateTimeOffset? Until { get; set; }

    /// <summary>The size of a page.</summary>
    public int? Limit { get; set; }

    /// <summary>The page to read: an earlier page's <see cref="Page{T}.NextCursor"/>.</summary>
    public string? Cursor { get; set; }

    internal string ToQuery(string? cursor) => new Query()
        .Add("template", Template)
        .Add("status", Status)
        .Add("environment", Environment)
        .Add("since", Since)
        .Add("until", Until)
        .Add("limit", Limit)
        .Add("cursor", cursor)
        .ToString();
}

/// <summary>Which templates a list holds. What is left null does not filter.</summary>
public sealed class TemplateListQuery
{
    /// <summary>Only templates of this kind: <c>pdf</c>, <c>image</c>, <c>docx</c> or <c>pptx</c>.</summary>
    public string? Kind { get; set; }

    /// <summary>Only templates in this language: <c>jinja2</c>, <c>liquid</c> or <c>handlebars</c>.</summary>
    public string? Engine { get; set; }

    /// <summary>Only templates with this tag.</summary>
    public string? Tag { get; set; }

    /// <summary>Only templates whose name or slug holds this text (the API's <c>q</c>).</summary>
    public string? Search { get; set; }

    /// <summary>The size of a page.</summary>
    public int? Limit { get; set; }

    /// <summary>The page to read: an earlier page's <see cref="Page{T}.NextCursor"/>.</summary>
    public string? Cursor { get; set; }

    internal string ToQuery(string? cursor) => new Query()
        .Add("kind", Kind)
        .Add("engine", Engine)
        .Add("tag", Tag)
        .Add("q", Search)
        .Add("limit", Limit)
        .Add("cursor", cursor)
        .ToString();
}

/// <summary>Which files of the library a list holds, newest first.</summary>
public sealed class FileListQuery
{
    /// <summary>Only files whose names start with this, such as <c>brand/</c>.</summary>
    public string? Prefix { get; set; }

    /// <summary>The size of a page.</summary>
    public int? Limit { get; set; }

    /// <summary>The page to read: an earlier page's <see cref="Page{T}.NextCursor"/>.</summary>
    public string? Cursor { get; set; }

    internal string ToQuery(string? cursor) => new Query()
        .Add("prefix", Prefix)
        .Add("limit", Limit)
        .Add("cursor", cursor)
        .ToString();
}

/// <summary>What <see cref="TemplateService.ValidateAsync"/> checks: a version of the template with data.</summary>
public sealed class TemplateValidation
{
    /// <summary><c>published</c> (the API's default), <c>latest</c>, a version number or a release channel.</summary>
    public string? Version { get; set; }

    /// <summary>The data to check; the version's sample data when null.</summary>
    public IDictionary<string, object?>? Data { get; set; }

    internal FieldList ToFields() => new FieldList().Add("version", Version).Add("data", Data);
}

/// <summary>A webhook endpoint to register.</summary>
public sealed class WebhookCreate
{
    /// <summary>An https address on a public host.</summary>
    public string Url { get; set; } = "";

    /// <summary>The events to receive; the API's default is renders and jobs, completed or failed.</summary>
    public IList<string>? Events { get; set; }

    /// <summary>The render environments whose events it receives: <c>live</c>, <c>test</c>; both by default.</summary>
    public IList<string>? Environments { get; set; }

    /// <summary>Your note on the endpoint.</summary>
    public string? Description { get; set; }

    /// <summary>Fields this SDK does not name, sent as given; one of a named field's name replaces it.</summary>
    public IDictionary<string, object?>? AdditionalFields { get; set; }

    internal FieldList ToFields() => new FieldList()
        .Add("url", Url)
        .Add("events", Events)
        .Add("environments", Environments)
        .Add("description", Description)
        .SetAll(AdditionalFields);
}

/// <summary>What to change of a webhook endpoint; what is left null stays.</summary>
public sealed class WebhookUpdate
{
    /// <summary>A new https address.</summary>
    public string? Url { get; set; }

    /// <summary>The events to receive.</summary>
    public IList<string>? Events { get; set; }

    /// <summary>The render environments whose events it receives.</summary>
    public IList<string>? Environments { get; set; }

    /// <summary><c>false</c> switches the endpoint off; <c>true</c> on again, which resets its failures.</summary>
    public bool? Enabled { get; set; }

    /// <summary>A new note.</summary>
    public string? Description { get; set; }

    /// <summary>Removes the note: sends <c>description: null</c>.</summary>
    public bool ClearDescription { get; set; }

    /// <summary>Fields this SDK does not name, sent as given; one of a named field's name replaces it.</summary>
    public IDictionary<string, object?>? AdditionalFields { get; set; }

    internal FieldList ToFields()
    {
        var fields = new FieldList()
            .Add("url", Url)
            .Add("events", Events)
            .Add("environments", Environments)
            .Add("enabled", Enabled);
        if (ClearDescription)
        {
            fields.Set("description", null);
        }
        else
        {
            fields.Add("description", Description);
        }
        return fields.SetAll(AdditionalFields);
    }
}
