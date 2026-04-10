import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, IsOptional, IsString } from 'class-validator';

export class AggregationDto {
    @ApiProperty({
        description: 'Associated cohort ID',
        example: '123e4567-e89b-12d3-a456-426614174001',
        type: 'string',
        format: 'uuid',
        required: false
    })
    @IsOptional()
    @IsUUID()
    cohortId?: string;

    @ApiProperty({
        description: 'Associated pathway ID',
        example: '123e4567-e89b-12d3-a456-426614174001',
        type: 'string',
        format: 'uuid',
        required: false
    })
    @IsOptional()
    @IsUUID()
    pathwayId?: string;

    @ApiProperty({
        description: 'Filter parameters for content type (e.g., event)',
        example: 'event',
        type: 'string',
        required: false
    })
    @IsOptional()
    @IsString()
    contentType?: string;

    @ApiProperty({
        description: 'User ID for fetching user-specific tracking (progress, status, etc.)',
        example: '77a456c8-0b3b-46fc-b6b2-d53353fc737c',
        type: 'string',
        format: 'uuid',
        required: false
    })
    @IsOptional()
    @IsUUID()
    userId?: string;
}

export class TrackingDto {
    @ApiProperty()
    status: string;

    @ApiProperty({ required: false })
    progress?: number;

    @ApiProperty({ required: false })
    completedLessons?: number;

    @ApiProperty({ required: false })
    totalLessons?: number;

    @ApiProperty({ required: false })
    lastAccessed?: Date;

    @ApiProperty({ required: false })
    timeSpent?: number;

    @ApiProperty({ required: false })
    score?: number;

    @ApiProperty({ required: false })
    attempt?: number;
}

export class MediaDto {
    @ApiProperty({ required: false })
    mediaId?: string;

    @ApiProperty({ required: false })
    format?: string;

    @ApiProperty({ required: false })
    subFormat?: string;

    @ApiProperty({ required: false })
    path?: string;

    @ApiProperty({ required: false })
    source?: string;
}

export class AssociatedFileDto {
    @ApiProperty()
    lessonID: string;

    @ApiProperty()
    mediaId: string;

    @ApiProperty()
    media: MediaDto;
}

export class AssociatedLessonDto {
    @ApiProperty()
    lessonId: string;

    @ApiProperty()
    title: string;

    @ApiProperty({ required: false })
    desc?: string;

    @ApiProperty({ required: false })
    image?: string;

    @ApiProperty({ required: false })
    startDateTime?: Date;

    @ApiProperty({ required: false })
    endDateTime?: Date;

    @ApiProperty()
    format: string;

    @ApiProperty()
    subformat: string;

    @ApiProperty()
    resume: boolean;

    @ApiProperty({ required: false })
    media?: MediaDto;

    @ApiProperty({ type: [AssociatedFileDto], required: false })
    associatedFiles?: AssociatedFileDto[];

    @ApiProperty({ required: false })
    tracking?: TrackingDto;
}

export class ContentDetailDto {
    @ApiProperty()
    lessonId: string;

    @ApiProperty()
    title: string;

    @ApiProperty({ required: false })
    description?: string;

    @ApiProperty({ required: false })
    image?: string;

    @ApiProperty({ required: false })
    startDateTime?: Date;

    @ApiProperty({ required: false })
    endDateTime?: Date;

    @ApiProperty()
    format: string;

    @ApiProperty()
    subFormat: string;

    @ApiProperty()
    resume: boolean;

    @ApiProperty()
    ordering: number;

    @ApiProperty({ required: false })
    media?: MediaDto;

    @ApiProperty({ type: [AssociatedFileDto], required: false })
    associatedFiles?: AssociatedFileDto[];

    @ApiProperty({ type: [AssociatedLessonDto], required: false })
    associatedLesson?: AssociatedLessonDto[];

    @ApiProperty({ required: false })
    tracking?: TrackingDto;
}

export class ModuleDetailDto {
    @ApiProperty()
    moduleId: string;

    @ApiProperty()
    courseId: string;

    @ApiProperty()
    title: string;

    @ApiProperty({ required: false })
    description?: string;

    @ApiProperty({ required: false })
    image?: string;

    @ApiProperty({ required: false })
    tracking?: TrackingDto;

    @ApiProperty({ type: [ContentDetailDto] })
    contents: ContentDetailDto[];
}

export class AggregatedCourseResponseDto {
    @ApiProperty()
    courseId: string;

    @ApiProperty()
    title: string;

    @ApiProperty({ required: false })
    shortDescription?: string;

    @ApiProperty({ required: false })
    description?: string;

    @ApiProperty({ required: false })
    image?: string;

    @ApiProperty({ required: false })
    tracking?: TrackingDto;

    @ApiProperty({ type: [ModuleDetailDto] })
    modules: ModuleDetailDto[];
}

export class AggregatedResponseDto {
    @ApiProperty({ type: [AggregatedCourseResponseDto] })
    courses: AggregatedCourseResponseDto[];
}

export class AggregationHeadersDto {
    @ApiProperty({
        description: 'Authentication token for external API calls',
        example: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        type: 'string'
    })
    @IsString()
    authorization: string;
}