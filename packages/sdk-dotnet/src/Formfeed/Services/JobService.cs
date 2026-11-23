using System;
using System.Diagnostics;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>Jobs: the batches of <see cref="RenderService.CreateBatchAsync"/>.</summary>
public sealed class JobService
{
    private readonly Transport transport;

    internal JobService(Transport transport) => this.transport = transport;

    /// <summary>A job by its id, with every item as a render.</summary>
    public async Task<Job> GetAsync(string id, CancellationToken cancellationToken = default)
    {
        var json = await transport
            .ObjectAsync(HttpMethod.Get, "/jobs/" + Ids.Path(id), null, null, cancellationToken)
            .ConfigureAwait(false);
        return Job.FromJson(json);
    }

    /// <summary>Polls until no render of the job is queued or running.</summary>
    /// <param name="id">The job.</param>
    /// <param name="timeout">How long to wait at most; ten minutes by default.</param>
    /// <param name="interval">How long between two reads; two seconds by default.</param>
    /// <param name="cancellationToken">Stops the wait.</param>
    /// <exception cref="FormfeedException">with <c>timeout</c> when the job did not finish in time.</exception>
    public async Task<Job> WaitForAsync(
        string id,
        TimeSpan? timeout = null,
        TimeSpan? interval = null,
        CancellationToken cancellationToken = default)
    {
        var limit = timeout ?? TimeSpan.FromSeconds(600);
        var step = interval ?? TimeSpan.FromSeconds(2);
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
                throw new FormfeedException("timeout", $"job {id} did not finish within the wait time");
            }
            await transport.WaitAsync(step, cancellationToken).ConfigureAwait(false);
            waited += step;
        }
    }

    /// <inheritdoc cref="WaitForAsync(string, TimeSpan?, TimeSpan?, CancellationToken)"/>
    public Task<Job> WaitForAsync(
        Job job,
        TimeSpan? timeout = null,
        TimeSpan? interval = null,
        CancellationToken cancellationToken = default) =>
        WaitForAsync(Guard.NotNull(job, nameof(job)).Id, timeout, interval, cancellationToken);
}
