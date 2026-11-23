package formfeed

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// The SDK's half of the operations table (plan 34, decision 9): operations.json names a method for
// every operation of the API, as Service.Method of the Client, or why there is none.
// packages/api-types/src/lib/sdk-fixtures.spec.ts holds the names to the API; these hold them to
// the client, so a renamed method fails here.

// helpers are the methods that call no operation of their own.
var helpers = []string{"All", "WaitFor", "Download", "DownloadTo", "DownloadFile"}

func operations(t *testing.T) (named map[string]string, none map[string]string) {
	t.Helper()
	data, err := os.ReadFile("operations.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Operations map[string]json.RawMessage `json:"operations"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	named, none = map[string]string{}, map[string]string{}
	for operation, value := range file.Operations {
		var path string
		var reason struct {
			None string `json:"none"`
		}
		switch {
		case json.Unmarshal(value, &path) == nil:
			named[operation] = path
		case json.Unmarshal(value, &reason) == nil && strings.TrimSpace(reason.None) != "":
			none[operation] = reason.None
		default:
			t.Fatalf("%s: neither a method nor a reason: %s", operation, value)
		}
	}
	return named, none
}

func TestTheFirstReleaseNamesItsThirtyFourOperations(t *testing.T) {
	named, _ := operations(t)
	if len(named) != 34 {
		t.Fatalf("%d operations have a method, want 34", len(named))
	}
}

func TestTheNamedMethodsExist(t *testing.T) {
	named, _ := operations(t)
	client := reflect.ValueOf(NewClient("ff_test_k"))
	contextType := reflect.TypeFor[context.Context]()
	for operation, path := range named {
		t.Run(operation, func(t *testing.T) {
			service, method, ok := strings.Cut(path, ".")
			if !ok {
				t.Fatalf("%s is not Service.Method", path)
			}
			field, found := reflect.TypeFor[Client]().FieldByName(service)
			if !found || !field.IsExported() {
				t.Fatalf("the client has no service %s", service)
			}
			value := client.Elem().FieldByName(service)
			if value.IsNil() {
				t.Fatalf("NewClient leaves %s nil", service)
			}
			fn := value.MethodByName(method)
			if !fn.IsValid() {
				t.Fatalf("%s has no method %s", service, method)
			}
			if fn.Type().NumIn() == 0 || fn.Type().In(0) != contextType {
				t.Fatalf("%s does not take a context first", path)
			}
		})
	}
}

// Every method of a service calls an operation the map names, or is one of the helpers, so a new
// method cannot ship without its place in the table.
func TestEveryMethodIsInTheTable(t *testing.T) {
	named, _ := operations(t)
	listed := map[string]bool{}
	for _, path := range named {
		listed[path] = true
	}
	clientType := reflect.TypeFor[Client]()
	for i := range clientType.NumField() {
		field := clientType.Field(i)
		if !field.IsExported() {
			continue
		}
		for j := range field.Type.NumMethod() {
			method := field.Type.Method(j).Name
			if !listed[field.Name+"."+method] && !slices.Contains(helpers, method) {
				t.Errorf("%s.%s calls no operation of operations.json", field.Name, method)
			}
		}
	}
}

// The map accounts for the operations of the API as the shared table lists them.
func TestTheTableAccountsForEveryOperation(t *testing.T) {
	data, err := os.ReadFile(repoPath(t, "api-types", "fixtures", "sdk", "operations.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Operations map[string]json.RawMessage `json:"operations"`
	}
	if err := json.Unmarshal(data, &table); err != nil {
		t.Fatal(err)
	}
	named, none := operations(t)
	for operation := range table.Operations {
		if _, ok := named[operation]; !ok {
			if _, ok := none[operation]; !ok {
				t.Errorf("operations.json does not account for %s", operation)
			}
		}
	}
	if got, want := len(named)+len(none), len(table.Operations); got != want {
		t.Errorf("operations.json names %d operations, the API has %d", got, want)
	}
}
