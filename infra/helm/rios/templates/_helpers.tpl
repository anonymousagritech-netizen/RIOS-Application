{{- define "rios.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "rios.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "rios.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "rios.labels" -}}
app.kubernetes.io/name: {{ include "rios.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "rios.serverImage" -}}
{{- printf "%s/%s:%s" .Values.image.registry .Values.image.server.repository .Values.image.server.tag -}}
{{- end -}}

{{- define "rios.webImage" -}}
{{- printf "%s/%s:%s" .Values.image.registry .Values.image.web.repository .Values.image.web.tag -}}
{{- end -}}
