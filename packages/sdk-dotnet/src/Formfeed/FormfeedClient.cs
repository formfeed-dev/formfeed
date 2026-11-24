using System;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>
/// The Formfeed API.
/// </summary>
/// <example>
/// <code>
/// using var formfeed = new FormfeedClient(Environment.GetEnvironmentVariable("FORMFEED_API_KEY"));
/// var render = await formfeed.Renders.CreateAsync(new RenderRequest { Template = "invoice", Data = data });
/// await formfeed.Renders.DownloadToAsync(render, "invoice.pdf");
/// </code>
/// </example>
/// <remarks>
/// It sends over an <see cref="HttpClient"/> of its own, or the one you pass, such as one of
/// <c>IHttpClientFactory</c>, which it then leaves to you to dispose. One client serves any number of
/// calls at the same time.
/// </remarks>
public sealed class FormfeedClient : IDisposable
{
    /// <summary>The release of this SDK, which every Formfeed package shares.</summary>
    public const string Version = "0.3.30";

    private readonly Transport transport;

    /// <summary>A client with the API key and the defaults: the EU region, three retries, 120 seconds per attempt.</summary>
    /// <exception cref="FormfeedException">with <c>invalid_request</c> when the key is empty.</exception>
    public FormfeedClient(string? apiKey)
        : this(new FormfeedClientOptions { ApiKey = apiKey ?? "" }, null)
    {
    }

    /// <summary>A client with the API key that sends over your <see cref="HttpClient"/>.</summary>
    /// <exception cref="FormfeedException">with <c>invalid_request</c> when the key is empty.</exception>
    public FormfeedClient(string? apiKey, HttpClient httpClient)
        : this(new FormfeedClientOptions { ApiKey = apiKey ?? "" }, Guard.NotNull(httpClient, nameof(httpClient)))
    {
    }

    /// <summary>A client with the options given.</summary>
    /// <exception cref="FormfeedException">with <c>invalid_request</c> when the key is empty or the region unknown.</exception>
    public FormfeedClient(FormfeedClientOptions options)
        : this(options, null)
    {
    }

    /// <summary>A client with the options given that sends over your <see cref="HttpClient"/>, or its own when null.</summary>
    /// <exception cref="FormfeedException">with <c>invalid_request</c> when the key is empty or the region unknown.</exception>
    public FormfeedClient(FormfeedClientOptions options, HttpClient? httpClient)
    {
        Guard.NotNull(options, nameof(options));
        if (string.IsNullOrEmpty(options.ApiKey))
        {
            throw new FormfeedException("invalid_request", "apiKey is required");
        }
        var host = options.BaseUrl is { } baseUrl
            ? baseUrl.IsAbsoluteUri ? baseUrl.AbsoluteUri : baseUrl.OriginalString
            : options.Region switch
            {
                "eu" => "https://api-eu.formfeed.dev/v1",
                "us" => "https://api-us.formfeed.dev/v1",
                _ => throw new FormfeedException(
                    "invalid_request",
                    $"unknown region {options.Region}: eu or us, or a baseUrl"),
            };

        transport = new Transport(options, host.TrimEnd('/'), httpClient);
        Renders = new RenderService(transport);
        Jobs = new JobService(transport);
        Pdf = new PdfService(transport);
        Einvoices = new EinvoiceService(transport);
        Files = new FileService(transport);
        Templates = new TemplateService(transport);
        Webhooks = new WebhookService(transport);
        Account = new AccountService(transport);
    }

    /// <summary>Renders: create, read, wait for, download, list, and batches.</summary>
    public RenderService Renders { get; }

    /// <summary>Jobs: the batches.</summary>
    public JobService Jobs { get; }

    /// <summary>The PDF tools.</summary>
    public PdfService Pdf { get; }

    /// <summary>E-invoice validation.</summary>
    public EinvoiceService Einvoices { get; }

    /// <summary>The file library.</summary>
    public FileService Files { get; }

    /// <summary>Templates, read and checked.</summary>
    public TemplateService Templates { get; }

    /// <summary>Webhook endpoints.</summary>
    public WebhookService Webhooks { get; }

    /// <summary>The key's account and its usage.</summary>
    public AccountService Account { get; }

    /// <summary>
    /// Any call of the API with the client's key, retries and problems, for one without a method here
    /// (template authoring, release channels, shared partials, the brand kit).
    /// </summary>
    /// <param name="method">The HTTP method.</param>
    /// <param name="path">The path after <c>/v1</c>, with its query, such as <c>/brand</c>.</param>
    /// <param name="body">The JSON body: a dictionary, a list or a JSON value; none when null.</param>
    /// <param name="idempotencyKey">Sent as <c>Idempotency-Key</c> when given.</param>
    /// <param name="cancellationToken">Stops the call.</param>
    /// <returns>The decoded JSON answer, null for an answer without a body.</returns>
    public Task<JsonElement?> RequestAsync(
        HttpMethod method,
        string path,
        object? body = null,
        string? idempotencyKey = null,
        CancellationToken cancellationToken = default) =>
        transport.JsonAsync(
            Guard.NotNull(method, nameof(method)),
            Guard.NotNull(path, nameof(path)),
            body,
            idempotencyKey,
            cancellationToken);

    /// <summary>Disposes the <see cref="HttpClient"/> the client made itself; one you passed stays yours.</summary>
    public void Dispose() => transport.Dispose();
}
