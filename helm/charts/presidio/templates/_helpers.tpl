{{/*
Expand the name of the chart.
*/}}
{{- define "presidio.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this.
*/}}
{{- define "presidio.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "presidio.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "presidio.labels" -}}
helm.sh/chart: {{ include "presidio.chart" . }}
{{ include "presidio.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "presidio.selectorLabels" -}}
app.kubernetes.io/name: {{ include "presidio.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Analyzer name and labels
*/}}
{{- define "presidio.analyzer.fullname" -}}
{{- printf "%s-analyzer" (include "presidio.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "presidio.analyzer.labels" -}}
helm.sh/chart: {{ include "presidio.chart" . }}
{{ include "presidio.analyzer.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "presidio.analyzer.selectorLabels" -}}
app.kubernetes.io/name: {{ include "presidio.name" . }}-analyzer
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Anonymizer name and labels
*/}}
{{- define "presidio.anonymizer.fullname" -}}
{{- printf "%s-anonymizer" (include "presidio.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "presidio.anonymizer.labels" -}}
helm.sh/chart: {{ include "presidio.chart" . }}
{{ include "presidio.anonymizer.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "presidio.anonymizer.selectorLabels" -}}
app.kubernetes.io/name: {{ include "presidio.name" . }}-anonymizer
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
