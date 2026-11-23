using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>
/// The stored request of a render, to render it again: a template render carries
/// <see cref="Template"/> and <see cref="Data"/>, an ad-hoc one <see cref="Html"/>,
/// <see cref="Url"/> or <see cref="Markdown"/>. Passwords are never included.
/// </summary>
public sealed class RenderInput : IJsonOnDeserialized
{
    /// <summary>The render this request made.</summary>
    [JsonPropertyName("render_id")]
    public string RenderId { get; set; } = "";

    /// <summary>The template: id, slug, version and channel.</summary>
    [JsonPropertyName("template")]
    public RenderTemplate? Template { get; set; }

    /// <summary>The data of a template render.</summary>
    [JsonPropertyName("data")]
    public JsonElement? Data { get; set; }

    /// <summary>The HTML of an ad-hoc render.</summary>
    [JsonPropertyName("html")]
    public string? Html { get; set; }

    /// <summary>The Markdown of a Markdown render.</summary>
    [JsonPropertyName("markdown")]
    public string? Markdown { get; set; }

    /// <summary>The address of a URL render.</summary>
    [JsonPropertyName("url")]
    public string? Url { get; set; }

    /// <summary>The template language of <see cref="Html"/> or <see cref="Markdown"/>.</summary>
    [JsonPropertyName("engine")]
    public string? Engine { get; set; }

    /// <summary>The locale the request named.</summary>
    [JsonPropertyName("locale")]
    public string? Locale { get; set; }

    /// <summary>The output the request asked for.</summary>
    [JsonPropertyName("output")]
    public string? Output { get; set; }

    /// <summary>The settings of the request.</summary>
    [JsonPropertyName("settings")]
    public JsonElement? Settings { get; set; }

    /// <summary>The file name the request gave.</summary>
    [JsonPropertyName("filename")]
    public string? Filename { get; set; }

    /// <summary>The post-processing, without passwords.</summary>
    [JsonPropertyName("post")]
    public JsonElement? Post { get; set; }

    /// <summary>The request's own data.</summary>
    [JsonPropertyName("meta")]
    public IReadOnlyDictionary<string, JsonElement> Meta { get; set; } = Maps.Empty;

    /// <summary><c>live</c> or <c>test</c>.</summary>
    [JsonPropertyName("environment")]
    public string Environment { get; set; } = "";

    /// <summary>When the request was made.</summary>
    [JsonPropertyName("created_at")]
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>The answer as the API sent it.</summary>
    [JsonIgnore]
    public JsonElement Raw { get; internal set; }

    /// <summary>Reads a stored request.</summary>
    /// <exception cref="FormfeedException">with <c>invalid_response</c> when it is not one.</exception>
    public static RenderInput FromJson(JsonElement json)
    {
        var input = ModelReader.Read(json, FormfeedJson.Default.RenderInput);
        input.Raw = json.Clone();
        return input;
    }

    /// <summary>Reads a stored request from its JSON text.</summary>
    /// <exception cref="JsonException">when the text is not JSON.</exception>
    /// <exception cref="FormfeedException">with <c>invalid_response</c> when it is not one.</exception>
    public static RenderInput FromJson(string json) => FromJson(ModelReader.Parse(json));

    void IJsonOnDeserialized.OnDeserialized()
    {
        RenderId ??= "";
        Environment ??= "";
        Meta ??= Maps.Empty;
    }
}
