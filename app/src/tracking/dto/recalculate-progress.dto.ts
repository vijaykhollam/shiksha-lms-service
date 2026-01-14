import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, IsNotEmpty } from 'class-validator';
import { VALIDATION_MESSAGES } from '../../common/constants/response-messages.constant';

export class RecalculateProgressDto {
  @ApiProperty({
    description: 'Course ID for which to recalculate progress',
    example: '123e4567-e89b-12d3-a456-426614174000',
    type: 'string',
    format: 'uuid'
  })
  @IsUUID('4', { message: VALIDATION_MESSAGES.COMMON.UUID('Course ID') })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.COMMON.REQUIRED('Course ID') })
  courseId: string;
}


