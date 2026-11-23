using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>Renders: create, read, wait for, download, list, and batches.</summary>
public sealed class RenderService
{
    private readonly Transport transport;

    internal RenderService(Transport transport) => this.transport = transport;

    /// <summary>
    /// Renders a template, HTML, a URL or Markdown. Sync by default, so the answer is the finished
    /// render; <c>Mode = "async"</c> answers it queued. A retry of the same call sends the same
    /// Idempotency-Key, generated unless you pass one, so it cannot charge twice.
    /// </summary>
    /// <param name="request">The render.</param>
    /// <param name="idempotencyKey">Ties the render to something of yours, such as an order; a fresh key when null.</param>
    /// <param name="cancellationToken">Stops the call.</param>
    public async Task<Render> CreateAsync(
        RenderRequest request,
        string? idempotencyKey = null,
        CancellationToken cancellationToken = default)
    {
        Guard.NotNull(request, nameof(request));
        var json = await transport
            .ObjectAsync(HttpMethod.Post, "/renders", request.ToFields(), idempotencyKey ?? Ids.Key(), cancellationToken)
            .ConfigureAwait(false);
        return Render.FromJson(json);
    }

    /// <summary>A render by its id, with a fresh signed link while its output is stored.</summary>
    public async Task<Render> GetAsync(string id, CancellationToken cancellationToken = default)
    {
        var json = await transport
            .ObjectAsync(HttpMethod.Get, "/renders/" + Ids.Path(id), null, null, cancellationToken)
            .ConfigureAwait(false);
        return Render.FromJson(json);
    }

    /// <summary>One page of renders, newest first.</summary>
    public async Task<Page<Render>> ListAsync(RenderListQuery? query = null, CancellationToken cancellationToken = default) =>
        await ListPageAsync(query, query?.Cursor, cancellationToken).ConfigureAwait(false);

    /// <summary>Every render the query matches, page by page as you iterate.</summary>
    public async IAsyncEnumerable<Render> ListAllAsync(
        RenderListQuery? query = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        string? cursor = null;
        do
        {
            var page = await ListPageAsync(query, cursor, cancellationToken).ConfigureAwait(false);
            foreach (var render in page.Data)
            {
                yield return render;
            }
            cursor = page.NextCursor;
        }
        while (!string.IsNullOrEmpty(cursor));
    }

    /// <summary>Removes the stored files of a render before they expire. Needs the <c>file:delete</c> scope.</summary>
    public Task DeleteOutputsAsync(string id, CancellationToken cancellationToken = default) =>
        transport.JsonAsync(HttpMethod.Delete, "/renders/" + Ids.Path(id) + "/outputs", null, null, cancellationToken);

    /// <inheritdoc cref="DeleteOutputsAsync(string, CancellationToken)"/>
    public Task DeleteOutputsAsync(Render render, CancellationToken cancellationToken = default) =>
        DeleteOutputsAsync(Guard.NotNull(render, nameof(render)).Id, cancellationToken);

    /// <summary>
    /// The stored request of a render, to render it again. Needs <c>render:input</c>; answers
    /// <c>render_input_expired</c> (410) when the workspace keeps no requests or the period ended.
    /// </summary>
    public async Task<RenderInput> GetInputAsync(string id, CancellationToken cancellationToken = default)
    {
        var json = await transport
            .ObjectAsync(HttpMethod.Get, "/renders/" + Ids.Path(id) + "/input", null, null, cancellationToken)
            .ConfigureAwait(false);
        return RenderInput.FromJson(json);
    }

    /// <inheritdoc cref="GetInputAsync(string, CancellationToken)"/>
    public Task<RenderInput> GetInputAsync(Render render, CancellationToken cancellationToken = default) =>
        GetInputAsync(Guard.NotNull(render, nameof(render)).Id, cancellationToken);

    /// <summary>Queues many renders as one job; its renders keep the order of the items. Follow it with <see cref="JobService.WaitForAsync(string, TimeSpan?, TimeSpan?, CancellationToken)"/>.</summary>
    /// <param name="request">The batch.</param>
    /// <param name="idempotencyKey">Ties the batch to something of yours; a fresh key when null.</param>
    /// <param name="cancellationToken">Stops the call.</param>
    public async Task<Job> CreateBatchAsync(
        BatchRequest request,
        string? idempotencyKey = null,
        CancellationToken cancellationToken = default)
    {
        Guard.NotNull(request, nameof(request));
        var json = await transport
            .ObjectAsync(HttpMethod.Post, "/renders/batch", request.ToFields(), idempotencyKey ?? Ids.Key(), cancellationToken)
            .ConfigureAwait(false);
        return Job.FromJson(json);
    }

    /// <summary>Polls until the render succeeded or failed (an async one).</summary>
    /// <param name="id">The render.</param>
    /// <param name="timeout">How long to wait at most; 120 seconds by default.</param>
    /// <param name="interval">How long between two reads; one second by default.</param>
    /// <param name="cancellationToken">Stops the wait.</param>
    /// <exception cref="FormfeedException">with <c>timeout</c> when the render did not finish in time.</exception>
    public async Task<Render> WaitForAsync(
        string id,
        TimeSpan? timeout = null,
        TimeSpan? interval = null,
        CancellationToken cancellationToken = default)
    {
        var limit = timeout ?? TimeSpan.FromSeconds(120);
        var step = interval ?? TimeSpan.FromSeconds(1);
        var clock = Stopwatch.StartNew();
        var waited = TimeSpan.Zero;
        while (true)
        {
            var current = await GetAsync(id, cancellationToken).ConfigureAwait(false);
            if (current.IsFinished)
            {
                return current;
            }
            if ((clock.Elapsed > waited ? clock.Elapsed : waited) + step > limit)
            {
                throw new FormfeedException("timeout", $"render {id} did not finish within the wait time");
            }
            await transport.WaitAsync(step, cancellationToken).ConfigureAwait(false);
            waited += step;
        }
    }

    /// <inheritdoc cref="WaitForAsync(string, TimeSpan?, TimeSpan?, CancellationToken)"/>
    public Task<Render> WaitForAsync(
        Render render,
        TimeSpan? timeout = null,
        TimeSpan? interval = null,
        CancellationToken cancellationToken = default) =>
        WaitForAsync(Guard.NotNull(render, nameof(render)).Id, timeout, interval, cancellationToken);

    /// <summary>The output of a finished render, as bytes.</summary>
    /// <exception cref="FormfeedException">with <c>not_ready</c> when the render has no output, <c>download_failed</c> when the link answers an error.</exception>
    public async Task<byte[]> DownloadAsync(Render render, CancellationToken cancellationToken = default)
    {
        using var buffer = new MemoryStream();
        await DownloadToAsync(render, buffer, cancellationToken).ConfigureAwait(false);
        return buffer.ToArray();
    }

    /// <summary>The output of a finished render, read first by its id, as bytes.</summary>
    /// <exception cref="FormfeedException">with <c>not_ready</c> when the render has no output, <c>download_failed</c> when the link answers an error.</exception>
    public async Task<byte[]> DownloadAsync(string id, CancellationToken cancellationToken = default) =>
        await DownloadAsync(await GetAsync(id, cancellationToken).ConfigureAwait(false), cancellationToken)
            .ConfigureAwait(false);

    /// <summary>Writes the output of a finished render to a stream; answers the bytes written.</summary>
    /// <exception cref="FormfeedException">with <c>not_ready</c> when the render has no output, <c>download_failed</c> when the link answers an error.</exception>
    public Task<long> DownloadToAsync(Render render, Stream destination, CancellationToken cancellationToken = default)
    {
        Guard.NotNull(render, nameof(render));
        Guard.NotNull(destination, nameof(destination));
        if (render.DownloadUrl is not { Length: > 0 } url)
        {
            throw new FormfeedException("not_ready", $"render {render.Id} has no output ({render.Status})");
        }
        return transport.DownloadAsync(url, destination, cancellationToken);
    }

    /// <summary>Writes the output of a finished render to a file, which it replaces; answers the bytes written.</summary>
    /// <exception cref="FormfeedException">with <c>not_ready</c> when the render has no output, <c>download_failed</c> when the link answers an error.</exception>
    public async Task<long> DownloadToAsync(Render render, string path, CancellationToken cancellationToken = default)
    {
        Guard.NotNull(render, nameof(render));
        if (render.DownloadUrl is not { Length: > 0 })
        {
            throw new FormfeedException("not_ready", $"render {render.Id} has no output ({render.Status})");
        }
        using var file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true);
        return await DownloadToAsync(render, file, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Writes the output of a finished render, read first by its id, to a stream; answers the bytes written.</summary>
    public async Task<long> DownloadToAsync(string id, Stream destination, CancellationToken cancellationToken = default) =>
        await DownloadToAsync(await GetAsync(id, cancellationToken).ConfigureAwait(false), destination, cancellationToken)
            .ConfigureAwait(false);

    /// <summary>Writes the output of a finished render, read first by its id, to a file; answers the bytes written.</summary>
    public async Task<long> DownloadToAsync(string id, string path, CancellationToken cancellationToken = default) =>
        await DownloadToAsync(await GetAsync(id, cancellationToken).ConfigureAwait(false), path, cancellationToken)
            .ConfigureAwait(false);

    private async Task<Page<Render>> ListPageAsync(RenderListQuery? query, string? cursor, CancellationToken cancellationToken)
    {
        var path = "/renders" + (query ?? new RenderListQuery()).ToQuery(cursor);
        var json = await transport.ObjectAsync(HttpMethod.Get, path, null, null, cancellationToken).ConfigureAwait(false);
        return Page.FromJson(json, Render.FromJson);
    }
}
