package web

import "embed"

// Dist contains the generated frontend and is embedded into the server binary.
//
//go:embed all:dist
var Dist embed.FS
