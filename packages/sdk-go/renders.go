package formfeed

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"iter"
	"net/http"
	"os"
	"time"
)

// RendersService creates, reads, waits for and downloads renders, and queues batches.
type RendersService struct{ t *transport }

// Create renders a template, HTML, a URL or Markdown. It is synchronous by default, so the answer
// is the finished render; with Mode "async" it is the queued render, which WaitFor follows. Every
// call sends an Idempotency-Key, generated unless you pass WithIdempotencyKey, and its retries the
// same one, so a retry cannot charge twice.
func (s *RendersService) Create(ctx context.Context, req RenderRequest, opts ...CallOption) (*Render, error) {
	p, err := jsonPayload(req)
	if err != nil {
		return nil, err
	}
	return call[Render](ctx, s.t, http.MethodPost, "/renders", p, idempotencyKey(opts, true))
}

// Get reads a render. While its output is stored the answer carries a fresh DownloadURL.
func (s *RendersService) Get(ctx context.Context, id string) (*Render, error) {
	return call[Render](ctx, s.t, http.MethodGet, "/renders/"+escape(id), nil, "")
}

// List reads one page of renders, newest first.
func (s *RendersService) List(ctx context.Context, opts RenderListOptions) (*Page[Render], error) {
	return call[Page[Render]](ctx, s.t, http.MethodGet, "/renders"+opts.query(), nil, "")
}

// All iterates over every render the options match, reading page after page as the loop asks for
// them. An error ends the iteration as its last value:
//
//	for render, err := range client.Renders.All(ctx, formfeed.RenderListOptions{Status: "failed"}) {
//		if err != nil {
//			return err
//		}
//		fmt.Println(render.ID, render.CreatedAt)
//	}
func (s *RendersService) All(ctx context.Context, opts RenderListOptions) iter.Seq2[*Render, error] {
	return pages(func(cursor string) (*Page[Render], error) {
		page := opts
		page.Cursor = cursor
		return s.List(ctx, page)
	}, opts.Cursor)
}

// DeleteOutputs removes the stored files of a render before they expire. Needs the file:delete
// scope.
func (s *RendersService) DeleteOutputs(ctx context.Context, id string) error {
	return s.t.json(ctx, http.MethodDelete, "/renders/"+escape(id)+"/outputs", nil, "", nil)
}

// Input reads the stored request of a render, to render it again. Needs the render:input scope;
// answers render_input_expired (410) when the workspace keeps no requests or the period ended.
func (s *RendersService) Input(ctx context.Context, id string) (*RenderInput, error) {
	return call[RenderInput](ctx, s.t, http.MethodGet, "/renders/"+escape(id)+"/input", nil, "")
}

// Batch queues up to 1,000 renders as one job, whose renders keep the order of the items. It sends
// an Idempotency-Key as Create does.
func (s *RendersService) Batch(ctx context.Context, req BatchRequest, opts ...CallOption) (*Job, error) {
	p, err := jsonPayload(req)
	if err != nil {
		return nil, err
	}
	return call[Job](ctx, s.t, http.MethodPost, "/renders/batch", p, idempotencyKey(opts, true))
}

// WaitFor polls a render until it succeeded or failed, every second for at most 120 seconds
// (WithPollInterval, WithWaitTimeout), and answers an *Error of code timeout after that. A failed
// render is an answer, not an error: look at its Status and Error.
func (s *RendersService) WaitFor(ctx context.Context, id string, opts ...WaitOption) (*Render, error) {
	cfg := waitOptions(120*time.Second, time.Second, opts)
	return poll(ctx, s.t, cfg, func() (*Render, bool, error) {
		r, err := s.Get(ctx, id)
		if err != nil {
			return nil, false, err
		}
		return r, r.Finished(), nil
	}, "render "+id)
}

// Download reads the output of a finished render into memory. It follows the signed link, without
// the API key, and answers an *Error of code not_ready when the render has no output.
func (s *RendersService) Download(ctx context.Context, render *Render) ([]byte, error) {
	var buf bytes.Buffer
	if _, err := s.DownloadTo(ctx, render, &buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// DownloadTo streams the output of a finished render into w and answers the bytes written.
func (s *RendersService) DownloadTo(ctx context.Context, render *Render, w io.Writer) (int64, error) {
	if render == nil {
		return 0, &Error{Code: "invalid_request", Message: "no render to download"}
	}
	if render.DownloadURL == "" {
		return 0, &Error{Code: "not_ready", Message: fmt.Sprintf("render %s has no output (%s)", render.ID, render.Status)}
	}
	return s.t.download(ctx, render.DownloadURL, w)
}

// DownloadFile writes the output of a finished render to a file, which it creates or truncates,
// and answers the bytes written. A download that fails leaves no file behind.
func (s *RendersService) DownloadFile(ctx context.Context, render *Render, path string) (int64, error) {
	if render == nil || render.DownloadURL == "" {
		return s.DownloadTo(ctx, render, io.Discard)
	}
	file, err := os.Create(path)
	if err != nil {
		return 0, fmt.Errorf("formfeed: cannot write %s: %w", path, err)
	}
	n, err := s.DownloadTo(ctx, render, file)
	if closeErr := file.Close(); err == nil && closeErr != nil {
		err = fmt.Errorf("formfeed: cannot write %s: %w", path, closeErr)
	}
	if err != nil {
		return n, errors.Join(err, removeFile(path))
	}
	return n, nil
}

func removeFile(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// JobsService reads batches and waits for them.
type JobsService struct{ t *transport }

// Get reads a job with its counts, every item as a render, and the ZIP's link once a batch with
// Zip has finished.
func (s *JobsService) Get(ctx context.Context, id string) (*Job, error) {
	return call[Job](ctx, s.t, http.MethodGet, "/jobs/"+escape(id), nil, "")
}

// WaitFor polls a job until no render of it is queued or running, every 2 seconds for at most 600
// seconds (WithPollInterval, WithWaitTimeout), and answers an *Error of code timeout after that.
func (s *JobsService) WaitFor(ctx context.Context, id string, opts ...WaitOption) (*Job, error) {
	cfg := waitOptions(600*time.Second, 2*time.Second, opts)
	return poll(ctx, s.t, cfg, func() (*Job, bool, error) {
		j, err := s.Get(ctx, id)
		if err != nil {
			return nil, false, err
		}
		return j, j.Finished(), nil
	}, "job "+id)
}

// call makes a call whose answer is one model.
func call[T any](ctx context.Context, t *transport, method, path string, p *payload, key string) (*T, error) {
	var out T
	if err := t.object(ctx, method, path, p, key, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// poll reads until read says the thing is finished, waiting interval between reads, and gives up
// once the next read would come after timeout. It counts the time it waited as well as the time
// that passed, so a sleep that returns at once (a test's) ends the same way.
func poll[T any](ctx context.Context, t *transport, cfg waitConfig, read func() (*T, bool, error), what string) (*T, error) {
	started := time.Now()
	var waited time.Duration
	for {
		current, finished, err := read()
		if err != nil {
			return nil, err
		}
		if finished {
			return current, nil
		}
		if max(time.Since(started), waited)+cfg.interval > cfg.timeout {
			return nil, &Error{Code: "timeout", Message: what + " did not finish within the wait time"}
		}
		if err := t.wait(ctx, cfg.interval); err != nil {
			return nil, err
		}
		waited += cfg.interval
	}
}

// pages iterates over the items of a list, page after page, from the cursor given.
func pages[T any](list func(cursor string) (*Page[T], error), start string) iter.Seq2[*T, error] {
	return func(yield func(*T, error) bool) {
		cursor := start
		for {
			page, err := list(cursor)
			if err != nil {
				yield(nil, err)
				return
			}
			for i := range page.Data {
				if !yield(&page.Data[i], nil) {
					return
				}
			}
			if page.NextCursor == "" {
				return
			}
			cursor = page.NextCursor
		}
	}
}
