<?php

declare(strict_types=1);

namespace Formfeed\Resources;

use Formfeed\Internal\Ids;
use Formfeed\Internal\Multipart;
use Formfeed\Internal\Transport;
use Formfeed\Models\Render;
use Formfeed\Upload;

final class Einvoices
{
    /** @internal */
    public function __construct(private readonly Transport $transport) {}

    /**
     * Which rules an e-invoice passed. A render of this workspace's own e-invoice (a `Render` or its
     * id) is answered from the report it keeps, free; an XML Formfeed did not make (an `Upload`, up to
     * 4 MB, from the Starter plan) takes one of the organisation's validations of the day. Needs
     * `einvoice:validate`.
     *
     * @param string|null $rules `auto`, `factur-x`, `xrechnung` or `en16931`; the render's own when null
     *
     * @return array<string, mixed> the report: verdict, rules, findings and versions
     */
    public function validate(Render|Upload|string $source, ?string $rules = null, ?string $idempotencyKey = null): array
    {
        $body = $source instanceof Upload
            ? new Multipart(['rules' => $rules], $source)
            : ['render_id' => Ids::of($source), ...($rules === null ? [] : ['rules' => $rules])];

        return $this->transport->object('POST', '/einvoices/validate', $body, $idempotencyKey ?? Ids::key());
    }
}
