package formfeed

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The contract goldens (plan 25 §5.3): what the API answers today, written by the gateway's
// contract.spec.ts. Each is read with the model its name starts with, strictly, so that a model
// whose field has another type than today's answer fails here, before it ships: in use, the models
// read such a field as its zero value. They live in the Formfeed repository only, and these tests
// skip elsewhere.
func TestTheSDKReadsTheContractGoldens(t *testing.T) {
	folder := repoPath(t, "api-types", "fixtures", "contract")
	files, err := filepath.Glob(filepath.Join(folder, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatalf("no goldens in %s", folder)
	}
	strictDecoding.Store(true)
	defer strictDecoding.Store(false)

	for _, file := range files {
		name := strings.TrimSuffix(filepath.Base(file), ".json")
		t.Run(name, func(t *testing.T) {
			data, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			is := func(prefix string) bool { return name == prefix || strings.HasPrefix(name, prefix+"-") }
			switch {
			case is("render-page"):
				var page Page[Render]
				strict(t, data, &page)
				if len(page.Data) == 0 {
					t.Fatal("an empty page")
				}
				for _, r := range page.Data {
					if !strings.HasPrefix(r.ID, "rnd_") {
						t.Fatalf("a render id %q", r.ID)
					}
				}
			case is("render-input"):
				var input RenderInput
				strict(t, data, &input)
				if !strings.HasPrefix(input.RenderID, "rnd_") {
					t.Fatalf("a render id %q", input.RenderID)
				}
			case strings.HasPrefix(name, "render"):
				var r Render
				strict(t, data, &r)
				if !strings.HasPrefix(r.ID, "rnd_") || r.Status == "" {
					t.Fatalf("a render %q in status %q", r.ID, r.Status)
				}
				if string(r.Raw) != strings.TrimSpace(string(data)) {
					t.Fatal("Raw is not the answer as it came")
				}
			case strings.HasPrefix(name, "job"):
				var job Job
				strict(t, data, &job)
				if !strings.HasPrefix(job.ID, "job_") {
					t.Fatalf("a job id %q", job.ID)
				}
				if len(job.Items) != job.Total {
					t.Fatalf("%d items, total %d", len(job.Items), job.Total)
				}
			default:
				t.Fatalf("%s.json: no model is named for this file", name)
			}
		})
	}
}

func strict(t *testing.T, data []byte, into any) {
	t.Helper()
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("today's answer does not fit %T: %v", into, err)
	}
}
